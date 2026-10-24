"""Validate and summarize the explicit no-answer prompt experiment."""

import hashlib
import json
import subprocess
from pathlib import Path
from statistics import mean

from budget_compare import annotate
from prompts import prompt

HERE = Path(__file__).resolve().parent
BASELINE = "sdk-nano-writes-28-v1"
CANDIDATE = "sdk-nano-no-answer-v1"
CONDITIONS = ["raw", "raw_ts", "sdk"]


def compare():
    configs = {
        n: json.loads((HERE / ".local/runs" / n / "config.json").read_text())
        for n in [BASELINE, CANDIDATE]
    }
    old, new = configs[BASELINE], configs[CANDIDATE]
    differences = sorted(k for k in old.keys() | new.keys() if old.get(k) != new.get(k))
    assert differences == [
        "conditions",
        "git_head",
        "prompts",
        "run",
        "source_sha256",
    ], differences
    assert new["conditions"] == CONDITIONS and new["steps"] == old["steps"] == 28
    assert not new["completion_feedback"]
    changed_sources = [
        k
        for k in old["source_sha256"]
        if old["source_sha256"][k] != new["source_sha256"][k]
    ]
    assert set(changed_sources) == {"prompts.py", "sdk_runner.py"}
    runner_old = (HERE / ".local/runs" / BASELINE / "source/sdk_runner.py").read_text()
    runner_new = (HERE / ".local/runs" / CANDIDATE / "source/sdk_runner.py").read_text()
    assert runner_new == runner_old.replace(
        'default=["raw", "static", "raw_ts", "sdk"]', 'default=["raw", "raw_ts", "sdk"]'
    )
    assert (
        subprocess.check_output(
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
            cwd=HERE.parents[2],
            text=True,
        )
        == ""
    )
    for c in CONDITIONS:
        expected = (
            old["prompts"][c]
            .replace(
                "Completion: apis.supervisor.complete_task(answer=value), or",
                "Completion: if no answer is required, apis.supervisor.complete_task(); if an answer is requested, apis.supervisor.complete_task(answer=value), or",
            )
            .replace(
                "Completion: await completeTask({answer: value}), or",
                "Completion: if no answer is required, await completeTask(); if an answer is requested, await completeTask({answer: value}), or",
            )
        )
        assert new["prompts"][c] == expected == prompt(c)
    rows = {}
    for name, config in configs.items():
        root = HERE / ".local/runs" / name
        for file, sha in config["source_sha256"].items():
            assert (
                hashlib.sha256((root / "source" / file).read_bytes()).hexdigest() == sha
            )
        rows[name] = [r for r in annotate(name) if r["condition"] in CONDITIONS]
        assert {(r["task_id"], r["condition"], r["repeat"]) for r in rows[name]} == {
            (t, c, i) for t in new["tasks"] for c in CONDITIONS for i in range(2)
        }
        for r in rows[name]:
            directory = HERE / ".local/runs" / r["trajectory_id"]
            assert r["success"] is not None and r["error_category"] is None
            steps = json.loads((directory / "steps.json").read_text())
            messages = json.loads((directory / "initial_messages.json").read_text())
            assert messages[0]["content"] == config["prompts"][r["condition"]]
            assert len(steps) == r["steps"] <= 28
            for field, usage in [
                ("prompt_tokens", "input_tokens"),
                ("generated_tokens", "output_tokens"),
            ]:
                assert r[field] == sum(s["model"]["usage"][usage] for s in steps)
            assert (
                abs(
                    r["estimated_usd"] - sum(s["model"]["estimated_usd"] for s in steps)
                )
                < 1e-10
            )
    aggregates = []
    for name, episodes in rows.items():
        for c in CONDITIONS:
            es = [r for r in episodes if r["condition"] == c]
            writes = [r for r in es if r["task_id"].startswith("afc0fce_")]
            aggregates.append(
                {
                    "run": name,
                    "condition": c,
                    "episodes": len(es),
                    "success": sum(r["success"] for r in es),
                    "write_success": sum(r["success"] for r in writes),
                    "correct_write_state": sum(
                        r["write_state_checks_passed"] for r in writes
                    ),
                    "answer_only_failures": sum(
                        r["failure_categories"] == ["answer"] for r in writes
                    ),
                    "write_answer_failures": sum(
                        "answer" in r["failure_categories"] for r in writes
                    ),
                    "completed": sum(r["completed"] for r in es),
                    "mean_turns": mean(r["steps"] for r in es),
                    "mean_seconds": mean(r["seconds"] for r in es),
                    "mean_input_tokens": mean(r["prompt_tokens"] for r in es),
                    "mean_output_tokens": mean(r["generated_tokens"] for r in es),
                    "seconds": sum(r["seconds"] for r in es),
                    "estimated_usd": sum(r["estimated_usd"] for r in es),
                }
            )
    return {
        "baseline": BASELINE,
        "candidate": CANDIDATE,
        "config_difference_fields": differences,
        "package_source_identical": True,
        "execution_change": "Default conditions exclude static; otherwise execution identical",
        "prompt_change": "Explicit no-answer completion example only",
        "aggregate": aggregates,
        "episodes": rows,
    }


if __name__ == "__main__":
    result = compare()
    (HERE / "evidence/completion-comparison.json").write_text(
        json.dumps(result, indent=2) + "\n"
    )
    for row in result["aggregate"]:
        print(json.dumps(row))
