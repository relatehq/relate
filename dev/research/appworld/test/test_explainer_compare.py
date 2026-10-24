"""Ensure selection cannot treat incomplete or mismatched pairs as improvements."""

import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import explainer_compare as compare


class CompareTests(unittest.TestCase):
    def compare(self, results):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            folder = root / ".local/explainer-batches/example"
            folder.mkdir(parents=True)
            attempts = []
            for index, (arm, success, turns, tokens) in enumerate(results):
                attempts.append(
                    {
                        "run": str(index),
                        "candidate": "actions",
                        "arm": arm,
                        "task": "one",
                        "repeat": 0,
                        "state": "finished" if success is not None else "incomplete",
                        "results": [
                            {
                                "success": success,
                                "error": None
                                if success is not None
                                else "connection failed",
                                "termination": "completed",
                                "steps": turns,
                                "prompt_tokens": tokens,
                                "generated_tokens": 20,
                                "estimated_usd": 0.01,
                                "seconds": 10,
                            }
                        ],
                    }
                )
            ledger = {
                "round": "screen",
                "planned_episodes": 2,
                "tasks": ["one"],
                "repeats": 1,
                "arms": ["baseline", "actions"],
                "prepared": {
                    arm: {"checkout": str(root / arm)}
                    for arm in ["baseline", "actions"]
                },
                "attempts": attempts,
            }
            (folder / "ledger.json").write_text(json.dumps(ledger))
            with patch.object(compare, "root", root):
                return compare.analyze("example")["comparisons"]["actions"]

    def test_more_official_passes_qualify(self):
        result = self.compare([("baseline", False, 5, 100), ("actions", True, 6, 110)])
        self.assertTrue(result["eligible"])
        self.assertTrue(result["gate"])

    def test_incomplete_control_cannot_qualify(self):
        result = self.compare([("baseline", None, 1, 10), ("actions", True, 6, 110)])
        self.assertFalse(result["eligible"])
        self.assertIsNone(result["gate"])

    def test_equal_accuracy_requires_efficiency_without_other_regression(self):
        self.assertTrue(
            self.compare([("baseline", True, 10, 100), ("actions", True, 9, 110)])[
                "gate"
            ]
        )
        self.assertFalse(
            self.compare([("baseline", True, 10, 100), ("actions", True, 9, 111)])[
                "gate"
            ]
        )
        self.assertFalse(
            self.compare([("baseline", True, 10, 100), ("actions", False, 1, 1)])[
                "gate"
            ]
        )


if __name__ == "__main__":
    unittest.main()
