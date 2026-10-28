import importlib.util
import json
from pathlib import Path
import unittest
import tempfile

spec = importlib.util.spec_from_file_location("company_report", Path(__file__).parents[1] / "report.py")
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class ReportTest(unittest.TestCase):
    def test_unstarted_and_failed_tasks_remain_in_denominator(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            (root / "manifest.json").write_text(json.dumps({"tasks": ["a", "b", "c"]}))
            (root / "a").mkdir()
            (root / "a/trial.json").write_text(json.dumps({"status": "scored", "result": {"final_score": {"result": 4, "total": 4}}}))
            (root / "b").mkdir()
            (root / "b/trial.json").write_text(json.dumps({"status": "error", "error": "setup failed"}))
            result = module.summarize(root)
            self.assertEqual(result["planned"], 3)
            self.assertEqual(result["scored"], 1)
            self.assertEqual(result["unscored"], 2)
            self.assertEqual(result["completionLowerBoundOverPlanned"], 1 / 3)


if __name__ == "__main__":
    unittest.main()
