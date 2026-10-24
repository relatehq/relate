import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from music_writes import MusicWrites
from task_catalog import ADDITIONAL_TASKS, IMPLEMENTED_TASKS, inventory


class MusicWriteTests(unittest.TestCase):
    def start(self, api):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        writer = MusicWrites(
            Path(temp.name) / "journal.sqlite3",
            SimpleNamespace(spotify=api),
            "secret",
            {"Song": [{"sourceId": "1"}]},
            "owner",
        )
        self.addCleanup(writer.close)
        return writer

    def test_confirmed_creation_survives_failed_refresh_and_reopen(self):
        api = SimpleNamespace(
            create_playlist=Mock(return_value={"message": "created", "playlist_id": 9})
        )
        writer = self.start(api)
        event = {
            "operation": "createPlaylist",
            "operationId": "stable",
            "input": {"title": "Test"},
        }
        with patch("music_writes.music_catalog", side_effect=TimeoutError):
            first = writer.execute(event)
            path = writer.db.execute("PRAGMA database_list").fetchone()[2]
            writer.close()
            writer = MusicWrites(
                path, SimpleNamespace(spotify=api), "secret", {}, "owner"
            )
            self.addCleanup(writer.close)
            second = writer.execute(event)
        self.assertEqual(first["mutationState"], "confirmed")
        self.assertEqual(first["refreshState"], "pending")
        self.assertEqual(second, first)
        api.create_playlist.assert_called_once()
        self.assertEqual(
            writer.execute({**event, "input": {"title": "Changed"}}),
            {"mutationState": "conflict"},
        )

    def test_lost_response_does_not_retry(self):
        api = SimpleNamespace(create_playlist=Mock(side_effect=TimeoutError))
        writer = self.start(api)
        event = {
            "operation": "createPlaylist",
            "operationId": "stable",
            "input": {"title": "Test"},
        }
        self.assertEqual(writer.execute(event), {"mutationState": "uncertain"})
        self.assertEqual(writer.execute(event), {"mutationState": "uncertain"})
        api.create_playlist.assert_called_once()

    def test_update_rating_preserves_review_text_and_rejects_invalid_input(self):
        api = SimpleNamespace(
            show_song_reviews=Mock(
                side_effect=lambda **kw: (
                    [{"song_review_id": 8}] if kw["page_index"] == 0 else []
                )
            ),
            update_song_review=Mock(return_value={"message": "updated"}),
        )
        writer = self.start(api)
        with patch(
            "music_writes.music_catalog", return_value={"Song": [{"sourceId": "1"}]}
        ):
            result = writer.execute(
                {
                    "operation": "rateSong",
                    "operationId": "rate",
                    "input": {"song": "1", "rating": 4},
                }
            )
        self.assertEqual(result["mutationState"], "confirmed")
        api.update_song_review.assert_called_once_with(
            access_token="secret", review_id=8, rating=4
        )
        with self.assertRaises(ValueError):
            writer.execute(
                {
                    "operation": "rateSong",
                    "operationId": "bad",
                    "input": {"song": "1", "rating": 2.5},
                }
            )
        with self.assertRaises(ValueError):
            writer.execute(
                {
                    "operation": "likeSong",
                    "operationId": "bad",
                    "input": {"song": "not-acquired"},
                }
            )

    def test_already_liked_is_noop(self):
        api = SimpleNamespace(
            show_song_privates=Mock(return_value={"liked": True}), like_song=Mock()
        )
        writer = self.start(api)
        with patch("music_writes.music_catalog", return_value={}):
            result = writer.execute(
                {"operation": "likeSong", "operationId": "like", "input": {"song": "1"}}
            )
        self.assertEqual(result["mutationState"], "confirmed")
        api.like_song.assert_not_called()

    def test_catalog_matches_train_dev_metadata(self):
        root = Path(__file__).resolve().parents[1] / ".local/world/data"
        if not root.exists():
            self.skipTest("AppWorld data not installed")
        catalog = inventory(root)
        self.assertEqual(len(ADDITIONAL_TASKS), 69)
        self.assertEqual(len(set(IMPLEMENTED_TASKS)), 81)
        self.assertEqual(
            sum(f["coverage"] == "expanded" for f in catalog["families"]), 23
        )
