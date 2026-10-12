import sys
import unittest
from pathlib import Path
from types import SimpleNamespace

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from music_acquire import music_catalog


class MusicCatalogTests(unittest.TestCase):
    def test_personal_rating_is_distinct_from_public_average_and_unrated(self):
        calls = []

        def collection(rows):
            return lambda **kwargs: rows if kwargs["page_index"] == 0 else []

        songs = [
            dict(
                song_id=i,
                title=str(i),
                album_id=None,
                duration=60,
                genre="test",
                release_date="2023-01-01",
                like_count=0,
                play_count=1,
                artists=[],
                rating=2.5,
            )
            for i in (1, 2)
        ]

        def reviews(**kwargs):
            calls.append(kwargs)
            return (
                [{"rating": 5}]
                if kwargs["song_id"] == 1 and kwargs["page_index"] == 0
                else []
            )

        api = SimpleNamespace(
            search_songs=collection(songs),
            search_albums=collection([]),
            search_artists=collection([]),
            show_playlist_library=collection([]),
            show_song_library=collection([{"song_id": 1}]),
            show_album_library=collection([]),
            show_liked_songs=collection([]),
            show_liked_albums=collection([]),
            show_downloaded_songs=collection([]),
            show_following_artists=collection([]),
            show_recommendations=collection([]),
            show_song_queue=lambda **kwargs: [],
            show_song_reviews=reviews,
        )
        rows = music_catalog(SimpleNamespace(spotify=api), "token", "owner")
        self.assertEqual(
            [(s["rating"], s["personalRating"]) for s in rows["SongState"]],
            [(2.5, 5), (2.5, None)],
        )
        self.assertTrue(all(c["user_email"] == "owner" for c in calls))
        self.assertEqual({r["song"] for r in rows["LibrarySong"]}, {"1"})
        self.assertEqual({r["sourceId"] for r in rows["Song"]}, {"1", "2"})
        self.assertEqual([c["page_index"] for c in calls if c["song_id"] == 1], [0, 1])
