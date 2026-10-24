"""Validate the retained 14/28-turn comparison and its local/public artifacts."""

import argparse
import hashlib
import json
import re
import subprocess
from pathlib import Path

from dotenv import dotenv_values
from prompts import COMMON, COMPLETION, prompt

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[2]
BASELINE = "sdk-nano-writes-v1"
CANDIDATE = "sdk-nano-writes-28-v1"


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def validate(credentials, explorer):
    configs = {
        n: json.loads((HERE / ".local/runs" / n / "config.json").read_text())
        for n in [BASELINE, CANDIDATE]
    }
    old, new = configs[BASELINE], configs[CANDIDATE]
    differences = sorted(k for k in old.keys() | new.keys() if old.get(k) != new.get(k))
    assert differences == ["git_head", "run", "steps"], differences
    assert old["steps"] == 14 and new["steps"] == 28
    package_changes = subprocess.check_output(
        [
            "git",
            "diff",
            "--name-only",
            old["git_head"],
            new["git_head"],
            "--",
            "packages",
            "connectors",
        ],
        cwd=ROOT,
        text=True,
    )
    assert package_changes == "", package_changes
    for name, config in configs.items():
        run = HERE / ".local/runs" / name
        expected = {
            (t, c, r)
            for t in config["tasks"]
            for c in config["conditions"]
            for r in range(config["repeats"])
        }
        observed = set()
        for filename, wanted in config["source_sha256"].items():
            assert (
                digest(run / "source" / filename) == digest(HERE / filename) == wanted
            )
        for path in run.glob("*__*/result.json"):
            row = json.loads(path.read_text())
            assert row["error"] is None and row["success"] is not None, path.parent.name
            observed.add((row["task_id"], row["condition"], row["repeat"]))
            messages = json.loads((path.parent / "initial_messages.json").read_text())
            system = messages[0]["content"]
            assert (
                system
                == config["prompts"][row["condition"]]
                == prompt(row["condition"])
            )
            assert system.startswith(COMMON) and system.count(COMPLETION) == 1
            steps = json.loads((path.parent / "steps.json").read_text())
            assert row["steps"] == len(steps) <= config["steps"]
            assert row["prompt_tokens"] == sum(
                s["model"]["usage"]["input_tokens"] for s in steps
            )
            assert row["generated_tokens"] == sum(
                s["model"]["usage"]["output_tokens"] for s in steps
            )
            assert (
                abs(row["model_seconds"] - sum(s["model"]["seconds"] for s in steps))
                < 1e-8
            )
            assert (
                abs(
                    row["estimated_usd"]
                    - sum(s["model"]["estimated_usd"] for s in steps)
                )
                < 1e-10
            )
            assert all(
                "Task status: incomplete." not in s["visible_output"] for s in steps
            )
            calls = json.loads((path.parent / "api_calls.json").read_text())
            assert row["setup_calls"] == 4
            assert len(calls) == row["setup_calls"] + row["acquisition_calls"] + sum(
                s["api_calls"] for s in steps
            )
            assert (
                row["agent_source_calls"]
                + row["setup_calls"]
                + row["acquisition_calls"]
                == row["source_calls"]
            )
            if row["condition"] != "sdk":
                assert row["acquisition_calls"] == row["snapshot_fetches"] == 0
        assert observed == expected and len(observed) == 24
        assert config["completion_feedback"] is False
    files = [
        p
        for p in (HERE / ".local/runs").rglob("*")
        if p.is_file() and "__pycache__" not in p.parts
    ]
    for path in files:
        restored = (
            HERE / ".local/restored/runs" / path.relative_to(HERE / ".local/runs")
        )
        assert restored.exists() and digest(path) == digest(restored), str(
            path.relative_to(HERE)
        )
    key = dotenv_values(credentials)["OPENAI_API_KEY"]
    public = [
        HERE / name
        for name in [
            "WRITE-BUDGET.md",
            "WRITE-BUDGET-PLAN.md",
            "README.md",
            "explorer.py",
            "explorer.html",
            "budget_compare.py",
            "validate_budget.py",
        ]
    ] + list((HERE / "evidence").glob("write-budget*.json"))
    for path in public:
        assert key not in path.read_text(), path.name
    for path in (HERE / "evidence").glob("write-budget*.json"):
        text = path.read_text()
        assert (
            "@gmail.com" not in text
            and "/Users/dennis" not in text
            and "eyJhbGci" not in text
        ), path.name
    webtext = (explorer / "data.json").read_text()
    data = json.loads(webtext)
    assert data[0]["id"] == CANDIDATE and len(data[0]["episodes"]) == 24
    assert data[1]["id"] == BASELINE and len(data[1]["episodes"]) == 24
    assert sum(len(r["episodes"]) for r in data) == 186
    assert key not in webtext and not re.search(
        r"eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+", webtext
    )
    assert all(
        "provider_output" not in s["model"]
        for r in data
        for e in r["episodes"]
        for s in e["steps"]
    )
    return {
        "baseline": BASELINE,
        "candidate": CANDIDATE,
        "episodes_each": 24,
        "source_hashes": new["source_sha256"],
        "config_difference_fields": differences,
        "baseline_head": old["git_head"],
        "candidate_head": new["git_head"],
        "package_source_identical": True,
        "execution_source_identical": True,
        "prompts_identical": True,
        "completion_guidance_once": True,
        "per_turn_feedback": False,
        "metric_sums_verified": True,
        "request_log_turn_partition_verified": True,
        "all_episodes_scored": True,
        "archive_files_roundtripped": len(files),
        "archive_sha256": digest(HERE / "evidence/trajectories.bundle"),
        "archive_bytes": (HERE / "evidence/trajectories.bundle").stat().st_size,
        "explorer_episodes": 186,
        "secret_scan": "provider key absent from new public files and explorer; public JSON excludes simulated email addresses and JWTs; explorer redacts JWTs and omits private provider continuation payloads",
        "scope": "Analysis/report changes only. Execution and SDK tests passed in the preceding pilot; no package or harness implementation changed here.",
    }


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--credentials", type=Path, required=True)
    parser.add_argument("--explorer", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    result = validate(args.credentials, args.explorer)
    args.output.write_text(json.dumps(result, indent=2) + "\n")
    print(
        "Verified both 24-episode runs, frozen contracts, metric sums, archive round-trip and redaction"
    )
