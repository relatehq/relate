"""Exercise resumed pair ordering and budget accounting with local child processes."""

import contextlib
import io
import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import explainer_batch as batch


class BatchTests(unittest.TestCase):
    def test_resumed_pairs_run_once_and_reserve_only_available_budget(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            folder = root / ".local/explainer-batches/test"
            folder.mkdir(parents=True)
            script = root / "sdk_runner.py"
            script.write_text("""import json,sys
from pathlib import Path
args=sys.argv[1:]
name=args[args.index('--run')+1]
cap=float(args[args.index('--max-cost-usd')+1])
p=Path(__file__).parent/'.local/runs'/name
p.mkdir(parents=True,exist_ok=False)
(p/'summary.json').write_text(json.dumps([{'estimated_usd':cap/10,'error':None,'success':True,'termination':'completed'}]))
""")
            ledger = {
                "tasks": ["t1", "t2"],
                "repeats": 1,
                "arms": ["baseline", "actions", "errors"],
                "planned_episodes": 8,
                "prepared": {
                    a: {"condition": "sdk"} for a in ["baseline", "actions", "errors"]
                },
                "attempts": [],
                "known_estimated_usd": 0.1,
                "maximum_usd": 1,
            }
            first = batch.schedule("test", ledger)[0][0]
            ledger["attempts"] = [
                dict(first, state="finished", exit=0, results=[{"estimated_usd": 0.1}])
            ]
            batch.save(folder / "ledger.json", ledger)
            with (
                patch.object(batch, "HERE", root),
                patch.object(batch, "verify", return_value=(root, root)),
                contextlib.redirect_stdout(io.StringIO()),
            ):
                batch.execute("test", root / "unused.env", 3)
            actual = json.loads((folder / "ledger.json").read_text())
            self.assertEqual(len(actual["attempts"]), 8)
            self.assertEqual(len({a["run"] for a in actual["attempts"]}), 8)
            self.assertLessEqual(actual["known_estimated_usd"], 1)
            self.assertTrue(all(a["state"] == "finished" for a in actual["attempts"]))
            self.assertFalse((root / ".local/runs" / first["run"]).exists())
            names = [a["run"] for a in actual["attempts"]]
            for pair in batch.schedule("test", ledger):
                self.assertLess(
                    names.index(pair[0]["run"]), names.index(pair[1]["run"])
                )

    def test_incomplete_attempt_is_never_retried(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            folder = root / ".local/explainer-batches/test"
            folder.mkdir(parents=True)
            batch.save(
                folder / "ledger.json",
                {"attempts": [{"run": "old", "state": "incomplete", "exit": 1}]},
            )
            with (
                patch.object(batch, "HERE", root),
                self.assertRaisesRegex(RuntimeError, "no automatic retry"),
            ):
                batch.execute("test", root / "unused.env", 3)


if __name__ == "__main__":
    unittest.main()
