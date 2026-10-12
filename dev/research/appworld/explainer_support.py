"""Task-independent host evidence for the retained coverage experiment.

The current graph accepts this metadata but does not publish collectionCoverage;
only the isolated coverage treatment consumes it. It is not runtime authorization.
"""

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
    if "Artist" in rows:
        scopes.update({
            "Song": "public-song-catalog", "Album": "public-album-catalog", "Artist": "public-artist-catalog",
            "AlbumMembership": "all-songs-in-catalog-albums", "SongState": "catalog-song-personal-state-and-public-rating",
            "AlbumState": "catalog-album-personal-likes", "SongArtist": "catalog-song-artists", "AlbumArtist": "catalog-album-artists",
            "LibrarySong": "deduplicated-personal-library-union", "Recommendation": "own-recommendation-occurrences",
            "QueueEntry": "own-player-queue",
        })
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
