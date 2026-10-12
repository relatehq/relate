"""Keep failed tool attempts and unfinished experiments out of positive evidence."""

import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import summarize


class SummaryTests(unittest.TestCase):
    def test_failed_traversal_and_infrastructure_are_not_successes(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            run = root / ".local/runs/synthetic"
            episode = run / "task__flat__11"
            episode.mkdir(parents=True)
            (run / "config.json").write_text(
                json.dumps(
                    {
                        "tasks": ["task"],
                        "conditions": ["flat", "compact"],
                        "seeds": [11],
                    }
                )
            )
            (episode / "trace.json").write_text(json.dumps({"steps": []}))
            (episode / "result.json").write_text(
                json.dumps(
                    {
                        "task_id": "task",
                        "condition": "flat",
                        "seed": 11,
                        "model": "synthetic",
                        "success": False,
                        "error": "connection failed",
                        "steps": 0,
                        "prompt_tokens": 0,
                        "generated_tokens": 0,
                        "source_calls": 0,
                        "seconds": 1,
                        "research_calls": [{"op": "traverse", "response_bytes": None}],
                    }
                )
            )
            with patch.object(summarize, "HERE", root):
                result = summarize.summarize(["synthetic"])
            row = result["episodes"][0]
            self.assertIsNone(row["success"])
            self.assertTrue(row["attempted_traversal"])
            self.assertFalse(row["used_traversal"])
            self.assertEqual(row["failed_research_calls"], 1)
            self.assertEqual(result["aggregate"][0]["valid_episodes"], 0)
            self.assertEqual(result["aggregate"][0]["infrastructure_errors"], 1)
            self.assertFalse(result["coverage"]["synthetic"]["complete"])
            self.assertEqual(result["coverage"]["synthetic"]["finished"], 1)
            self.assertEqual(result["coverage"]["synthetic"]["expected"], 2)


if __name__ == "__main__":
    unittest.main()
