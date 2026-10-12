"""Synthetic contract tests: no task data or model calls."""

import sys
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from runner import Research


class RunnerTests(unittest.TestCase):
    def world(self, pages):
        requests = []

        def playlists(**kwargs):
            requests.append({"method": "get"})
            return pages[kwargs["page_index"]]

        return SimpleNamespace(
            requester=SimpleNamespace(
                request_tracker=SimpleNamespace(requests=requests)
            ),
            apis=SimpleNamespace(
                spotify=SimpleNamespace(show_playlist_library=playlists)
            ),
        )

    def test_empty_snapshot_is_complete_only_after_source_page(self):
        world = self.world([[]])
        with patch("runner.subprocess.Popen"):
            research = Research(world, "compact")
        with patch.object(research, "bridge", return_value={"loaded": True}):
            result = research("load", access_token="synthetic")
        self.assertTrue(result["complete"])
        self.assertEqual(result["counts"]["Song"], 0)
        self.assertEqual(research.calls[0]["source_calls"], 1)

    def test_write_invalidates_snapshot(self):
        world = self.world([[]])
        with patch("runner.subprocess.Popen"):
            research = Research(world, "compact")
        with patch.object(research, "bridge", return_value={"loaded": True}):
            research("load", access_token="synthetic")
            world.requester.request_tracker.requests.append({"method": "post"})
            with self.assertRaisesRegex(ValueError, "invalidated"):
                research("list", kind="Song")

    def test_failed_reload_cannot_serve_previous_snapshot(self):
        world = self.world([[]])
        with patch("runner.subprocess.Popen"):
            research = Research(world, "compact")
        with patch.object(research, "bridge", return_value={"loaded": True}):
            research("load", access_token="synthetic")
        with patch.object(
            research, "bridge", side_effect=RuntimeError("adapter unavailable")
        ):
            with self.assertRaises(RuntimeError):
                research("load", access_token="synthetic")
        with self.assertRaisesRegex(ValueError, "first"):
            research("list", kind="Song")


if __name__ == "__main__":
    unittest.main()
