import importlib.util
import json
from pathlib import Path

spec = importlib.util.spec_from_file_location("agency_report", Path(__file__).parents[1] / "report.py")
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


def test_missing_and_unscored_remain_in_denominator(tmp_path):
    (tmp_path / "manifest.json").write_text(json.dumps({"runs": 1, "tasks": ["pass", "unscored", "absent"]}))
    (tmp_path / "run1").mkdir()
    (tmp_path / "run1/pass.json").write_text(json.dumps({"task_completion_pass": 1, "ux_score": 4}))
    (tmp_path / "run1/unscored.json").write_text('{}')
    report = module.summarize(tmp_path)
    assert report["planned"] == 3
    assert report["scored"] == 1
    assert report["missingOrUnscored"] == 2
    assert report["successRateOverPlanned"] == 1 / 3
    assert report["totalExperimentCostUsd"] is None
