"""Task-independent host evidence after all fixed acquisition calls succeeded."""

import freezegun.api as clock


def acquisition_coverage(rows):
    observed = int(clock.real_time() * 1000)
    scopes = {
        "Playlist": "own-playlist-library",
        "Song": "songs-in-own-playlists-saved-songs-and-saved-albums" if "MusicLibrary" in rows else "songs-in-own-playlist-library",
        "MusicLibrary": "own-music-library",
        "Album": "own-saved-albums",
        "SavedSong": "own-saved-song-memberships",
        "SavedAlbum": "own-saved-album-memberships",
        "AlbumMembership": "all-songs-in-own-saved-albums",
        "Membership": "own-playlist-memberships",
        "Person": "email-contacts-own-payment-parties-and-supervisor",
        "ContactRelationship": "email-contact-labels-owned-by-supervisor",
        "Transaction": "own-payment-transactions",
    }
    return {
        kind: {
            "scopeId": f"snapshot.{kind}",
            "predicateId": predicate,
            "observedAt": observed,
            "expiresAt": observed + 300_000,
            "pagination": "exhausted",
            "gaps": [],
        }
        for kind, predicate in scopes.items()
        if kind in rows
    }
