"""Task-independent public Spotify catalog and authenticated account acquisition.

Catalog membership is deliberately separate from library membership. No task
instruction, solution, evaluator or private database is read here.
"""

from acquire import pages
import json


def music_catalog(apis, token, owner):
    api = apis.spotify
    songs = pages(api.search_songs)
    albums = pages(api.search_albums)
    artists = pages(api.search_artists)
    playlists = pages(api.show_playlist_library, access_token=token)
    saved_songs = pages(api.show_song_library, access_token=token)
    saved_albums = pages(api.show_album_library, access_token=token)
    liked_songs = {
        s["song_id"] for s in pages(api.show_liked_songs, access_token=token)
    }
    liked_albums = {
        a["album_id"] for a in pages(api.show_liked_albums, access_token=token)
    }
    downloaded = {
        s["song_id"] for s in pages(api.show_downloaded_songs, access_token=token)
    }
    following = {
        a["artist_id"] for a in pages(api.show_following_artists, access_token=token)
    }
    recommended = pages(api.show_recommendations, access_token=token)
    queue = api.show_song_queue(access_token=token)
    if not isinstance(queue, list):
        raise ValueError("Queue API did not return a collection")
    library_ids = (
        {s["song_id"] for s in saved_songs}
        | {sid for a in saved_albums for sid in a["song_ids"]}
        | {sid for p in playlists for sid in p["song_ids"]}
    )
    song_ids = {s["song_id"] for s in songs}
    referenced = (
        library_ids
        | liked_songs
        | downloaded
        | {s["song_id"] for s in recommended + queue}
        | {sid for a in albums for sid in a["song_ids"]}
    )
    if not referenced <= song_ids:
        raise ValueError("Catalog acquisition omitted referenced songs")
    rows = {
        "MusicLibrary": [{"sourceId": owner, "owner": owner}],
        "Playlist": [
            {"sourceId": str(p["playlist_id"]), "title": p["title"]} for p in playlists
        ],
        "Song": [
            {
                "sourceId": str(s["song_id"]),
                "title": s["title"],
                "albumId": str(s["album_id"]) if s["album_id"] is not None else None,
                "duration": s["duration"],
                "genre": s["genre"],
                "releaseDate": s["release_date"],
                "likeCount": s["like_count"],
                "playCount": s["play_count"],
                "artistsJson": json.dumps(s["artists"], separators=(",", ":")),
            }
            for s in songs
        ],
        "Album": [
            {"sourceId": str(a["album_id"]), "title": a["title"]} for a in albums
        ],
        "Artist": [
            {
                "sourceId": str(a["artist_id"]),
                "name": a["name"],
                "genre": a["genre"],
                "followerCount": a["follower_count"],
                "following": a["artist_id"] in following,
            }
            for a in artists
        ],
        "SongState": [
            {
                "sourceId": str(s["song_id"]),
                "song": str(s["song_id"]),
                "rating": s["rating"],
                "liked": s["song_id"] in liked_songs,
                "downloaded": s["song_id"] in downloaded,
            }
            for s in songs
        ],
        "AlbumState": [
            {
                "sourceId": str(a["album_id"]),
                "album": str(a["album_id"]),
                "liked": a["album_id"] in liked_albums,
            }
            for a in albums
        ],
        "SavedSong": [
            {
                "sourceId": f"{owner}:{s['song_id']}",
                "library": owner,
                "song": str(s["song_id"]),
            }
            for s in saved_songs
        ],
        "SavedAlbum": [
            {
                "sourceId": f"{owner}:{a['album_id']}",
                "library": owner,
                "album": str(a["album_id"]),
            }
            for a in saved_albums
        ],
        "LibrarySong": [
            {"sourceId": f"{owner}:{sid}", "library": owner, "song": str(sid)}
            for sid in sorted(library_ids)
        ],
        "AlbumMembership": [
            {
                "sourceId": f"{a['album_id']}:{sid}",
                "album": str(a["album_id"]),
                "song": str(sid),
            }
            for a in albums
            for sid in a["song_ids"]
        ],
        "Membership": [
            {
                "sourceId": f"{p['playlist_id']}:{sid}",
                "playlist": str(p["playlist_id"]),
                "song": str(sid),
            }
            for p in playlists
            for sid in p["song_ids"]
        ],
        "SongArtist": [
            {
                "sourceId": f"{s['song_id']}:{a['id']}",
                "song": str(s["song_id"]),
                "artist": str(a["id"]),
            }
            for s in songs
            for a in s["artists"]
        ],
        "AlbumArtist": [
            {
                "sourceId": f"{a['album_id']}:{artist['id']}",
                "album": str(a["album_id"]),
                "artist": str(artist["id"]),
            }
            for a in albums
            for artist in a["artists"]
        ],
        "Recommendation": [
            {
                "sourceId": f"{owner}:{i}",
                "library": owner,
                "song": str(s["song_id"]),
                "position": i,
            }
            for i, s in enumerate(recommended)
        ],
        "QueueEntry": [
            {
                "sourceId": f"{owner}:{s['position']}",
                "library": owner,
                "song": str(s["song_id"]),
                "position": s["position"],
                "isCurrent": s["is_current"],
                "isPlaying": s["is_playing"],
            }
            for s in queue
        ],
    }
    return rows
