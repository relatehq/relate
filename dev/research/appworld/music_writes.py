"""Allowlisted Spotify mutations with durable outcome retention and readback.

A journal belongs to one episode/account. A lost response is uncertain, never
blindly retried. Snapshot refresh is read-only and uses the same acquisition as
initialization; it is not proof that an uncertain mutation did or did not occur.
"""

import json
from acquire import pages
from music_acquire import music_catalog
from source_writes import SourceWrites, canonical

OPERATIONS = {
    "likeSong": ("like_song", {"song": "song_id"}),
    "downloadSong": ("download_song", {"song": "song_id"}),
    "followArtist": ("follow_artist", {"artist": "artist_id"}),
    "unfollowArtist": ("unfollow_artist", {"artist": "artist_id"}),
    "removeSavedSong": ("remove_song_from_library", {"song": "song_id"}),
    "removeSavedAlbum": ("remove_album_from_library", {"album": "album_id"}),
    "removePlaylistSong": (
        "remove_song_from_playlist",
        {"playlist": "playlist_id", "song": "song_id"},
    ),
    "addPlaylistSong": (
        "add_song_to_playlist",
        {"playlist": "playlist_id", "song": "song_id"},
    ),
    "createPlaylist": ("create_playlist", {"title": "title"}),
    "playSong": ("play_music", {"song": "song_id"}),
    "queueSong": ("add_to_queue", {"song": "song_id"}),
    "nextSong": ("next_song", {}),
    "previousSong": ("previous_song", {}),
    "rateSong": ("review_song", {"song": "song_id", "rating": "rating"}),
}
TARGETS = {"song": "Song", "album": "Album", "artist": "Artist", "playlist": "Playlist"}


class MusicWrites(SourceWrites):
    def __init__(self, path, apis, token, rows, account_id):
        super().__init__(path, apis.spotify, token, set(), account_id)
        self.apis = apis
        self.account_id = account_id
        self.allowed = {
            kind: {r["sourceId"] for r in rows.get(kind, [])}
            for kind in TARGETS.values()
        }

    def refresh_music(self):
        try:
            rows = music_catalog(self.apis, self.token, self.account_id)
            self.allowed = {
                kind: {r["sourceId"] for r in rows.get(kind, [])}
                for kind in TARGETS.values()
            }
            return {"refreshState": "current", "rows": rows}
        except Exception:
            return {"refreshState": "pending"}

    def execute(self, event):
        operation = event["operation"]
        if operation == "refreshMusic":
            return {
                "mutationState": "none",
                "output": {"message": "Music refresh attempted", "sourceId": None},
                **self.refresh_music(),
            }
        if operation not in OPERATIONS:
            raise ValueError("Unsupported Spotify operation")
        api_name, mapping = OPERATIONS[operation]
        supplied = event.get("input", {})
        if set(supplied) != set(mapping):
            raise ValueError("Unexpected Spotify input fields")
        for field, kind in TARGETS.items():
            if field in supplied and supplied[field] not in self.allowed[kind]:
                raise ValueError(f"{kind} outside acquired graph")
        if operation == "rateSong" and (
            type(supplied["rating"]) is not int or not 1 <= supplied["rating"] <= 5
        ):
            raise ValueError("Rating must be an integer from 1 to 5")
        if operation == "createPlaylist" and (
            not isinstance(supplied["title"], str) or not supplied["title"].strip()
        ):
            raise ValueError("Playlist title is required")
        operation_id = event.get("operationId")
        if not isinstance(operation_id, str) or not operation_id.strip():
            raise ValueError("Stable SDK operationId is required")
        fingerprint = canonical({"operation": operation, "input": supplied})
        saved = self.db.execute(
            "SELECT request, result FROM operations WHERE id = ?", (operation_id,)
        ).fetchone()
        if saved:
            if saved[0] != fingerprint:
                return {"mutationState": "conflict"}
            if saved[1] is None:
                return {"mutationState": "uncertain"}
            output = json.loads(saved[1])
        else:
            args = {
                target: int(supplied[field]) if field in TARGETS else supplied[field]
                for field, target in mapping.items()
            }
            args["access_token"] = self.token
            if operation == "rateSong":
                # Resolve create-vs-update before reserving a mutation. This public
                # read cannot produce duplicate writes if it fails.
                reviews = pages(
                    self.api.show_song_reviews,
                    song_id=args["song_id"],
                    user_email=self.account_id,
                )
                if len(reviews) > 1:
                    raise ValueError("Multiple own reviews for one song")
                if reviews:
                    api_name = "update_song_review"
                    args = {
                        "access_token": self.token,
                        "review_id": reviews[0]["song_review_id"],
                        "rating": supplied["rating"],
                    }
            already_done = False
            if operation in {"likeSong", "downloadSong", "removeSavedSong"}:
                state = self.api.show_song_privates(
                    song_id=int(supplied["song"]), access_token=self.token
                )
                already_done = (
                    state["liked"]
                    if operation == "likeSong"
                    else state["downloaded"]
                    if operation == "downloadSong"
                    else not state["in_song_library"]
                )
            elif operation in {"followArtist", "unfollowArtist"}:
                state = self.api.show_artist_following(
                    artist_id=int(supplied["artist"]), access_token=self.token
                )
                already_done = state["following"] == (operation == "followArtist")
            elif operation == "removeSavedAlbum":
                already_done = not self.api.show_album_privates(
                    album_id=int(supplied["album"]), access_token=self.token
                )["in_album_library"]
            elif operation in {"addPlaylistSong", "removePlaylistSong"}:
                playlist = self.api.show_playlist(
                    playlist_id=int(supplied["playlist"]), access_token=self.token
                )
                present = int(supplied["song"]) in {
                    song["id"] for song in playlist["songs"]
                }
                already_done = present == (operation == "addPlaylistSong")
            self.db.execute(
                "INSERT INTO operations(id, request) VALUES (?, ?)",
                (operation_id, fingerprint),
            )
            try:
                result = (
                    {"message": "Requested state already present"}
                    if already_done
                    else getattr(self.api, api_name)(**args)
                )
                output = {
                    "message": result["message"],
                    "sourceId": str(result["playlist_id"])
                    if operation == "createPlaylist"
                    else None,
                }
                self.db.execute(
                    "UPDATE operations SET result = ? WHERE id = ?",
                    (canonical(output), operation_id),
                )
            except Exception:
                return {"mutationState": "uncertain"}
        return {"mutationState": "confirmed", "output": output, **self.refresh_music()}
