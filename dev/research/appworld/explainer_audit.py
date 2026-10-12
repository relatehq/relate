"""Audit frozen configurations and sanitized feature-use hints for a completed batch."""

import hashlib
import json
import sys
from collections import Counter
from pathlib import Path

from explainer_compare import analyze
from retained_usage import code_from_step

HERE = Path(__file__).resolve().parent


def audit(batch):
    ledger_path = HERE / ".local/explainer-batches" / batch / "ledger.json"
    ledger = json.loads(ledger_path.read_text())
    report = analyze(batch)
    assert report["finished"] == report["planned"]
    assert report["usage"]["requests_without_usage"] == 0
    providers = Counter()
    feature_cells = Counter()
    errors = Counter()
    expected = {
        "model": "gpt-5.4-nano",
        "reasoning": "low",
        "steps": 28,
        "max_output_tokens": 4096,
        "generated_budget": 14000,
        "output_chars": 14000,
        "repeats": 1,
    }
    for row in report["episodes"]:
        errors.update(row["error_turns"])
    for attempt in ledger["attempts"]:
        arm = attempt["arm"]
        run = (
            Path(ledger["prepared"][arm]["checkout"])
            / "dev/research/appworld/.local/runs"
            / attempt["run"]
        )
        config = json.loads((run / "config.json").read_text())
        assert all(config[k] == v for k, v in expected.items())
        assert config["tasks"] == [attempt["task"]]
        assert config["conditions"] == [ledger["prepared"][arm]["condition"]]
        for source in (run / "source").iterdir():
            if source.is_file():
                assert (
                    hashlib.sha256(source.read_bytes()).hexdigest()
                    == ledger["prepared"][arm]["support_sha256"][source.name]
                )
        evaluations = list(run.glob("*__*__*/evaluation.json"))
        assert len(evaluations) == len(attempt["results"]) == 1
        official = json.loads(evaluations[0].read_text())
        assert official["success"] is attempt["results"][0]["success"]
        for path in run.glob("*__*__*/steps.json"):
            for step in json.loads(path.read_text()):
                providers[step["model"]["model"]] += 1
                code = code_from_step(step)
                if arm == "filters" and "traverse" in code:
                    feature_cells["filter_arm_traversal_cells"] += 1
                    if "where" in code:
                        feature_cells["filter_arm_traversal_cells_with_where"] += 1
                if (
                    arm == "datetime"
                    and "createdAt" in code
                    and any(op in code for op in ["gte", "lte", " gt:", " lt:"])
                ):
                    feature_cells["datetime_arm_range_hint_cells"] += 1
                if arm == "collections" and (".page(" in code or ".records(" in code):
                    feature_cells["collection_arm_explicit_method_hint_cells"] += 1
    return {
        "batch": batch,
        "episodes": report["finished"],
        "configuration_and_frozen_runner_sources": "verified",
        "official_evaluator_results_match": report["finished"],
        "ledger_sha256": hashlib.sha256(ledger_path.read_bytes()).hexdigest(),
        "usage": report["usage"],
        "provider_model_calls": dict(providers),
        "error_turns": dict(errors),
        "feature_hint_cells": dict(feature_cells),
        "limits": [
            "Feature hints are lexical source matches, not instrumentation of runtime dispatch.",
            "Error categories classify returned error text; they do not establish causes of task failure.",
        ],
    }


if __name__ == "__main__":
    print(json.dumps(audit(sys.argv[1]), indent=2))
