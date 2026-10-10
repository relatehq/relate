"""Validate and summarize the explicit contact graph experiment."""

import hashlib
import json
import subprocess
from pathlib import Path
from statistics import mean

from budget_compare import annotate
from prompts import prompt

HERE = Path(__file__).resolve().parent
BASELINE = "sdk-nano-no-answer-v1"
CANDIDATE = "sdk-nano-contact-graph-v1"
CONDITIONS = ["raw", "raw_ts", "sdk"]


def compare():
    configs = {
        n: json.loads((HERE / ".local/runs" / n / "config.json").read_text())
        for n in [BASELINE, CANDIDATE]
    }
    old, new = configs[BASELINE], configs[CANDIDATE]
    differences = sorted(k for k in old.keys() | new.keys() if old.get(k) != new.get(k))
    assert differences == ["git_head", "run", "source_sha256"], differences
    assert new["conditions"] == CONDITIONS and new["steps"] == old["steps"] == 28
    assert not new["completion_feedback"]
    changed_sources = [
        k
        for k in old["source_sha256"]
        if old["source_sha256"][k] != new["source_sha256"][k]
    ]
    assert set(changed_sources) == {"acquire.py", "sdk-graph.mjs", "sdk_runner.py"}
    assert old["prompts"] == new["prompts"]
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
        assert new["prompts"][c] == prompt(c)
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
    old_by_case = {
        (r["task_id"], r["condition"], r["repeat"]): r for r in rows[BASELINE]
    }
    for row in rows[CANDIDATE]:
        previous = old_by_case[row["task_id"], row["condition"], row["repeat"]]
        assert row["acquisition_calls"] == previous["acquisition_calls"]
        root = HERE / ".local/runs" / row["trajectory_id"]
        previous_root = HERE / ".local/runs" / previous["trajectory_id"]
        # Same task context as well as system prompt, before any graph observation.
        assert json.loads((root / "initial_messages.json").read_text()) == json.loads(
            (previous_root / "initial_messages.json").read_text()
        )
        steps = json.loads((root / "steps.json").read_text())
        codes = [json.loads(s["content"]).get("code", "") for s in steps]
        row["contact_relationship_code_turns"] = [
            s["turn"]
            for s, c in zip(steps, codes)
            if "ContactRelationship" in c
            or "contactRelationships" in c
            or "labelsFromOthers" in c
        ]
        row["legacy_relationships_json_turns"] = [
            s["turn"] for s, c in zip(steps, codes) if "relationshipsJson" in c
        ]
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
        "execution_change": "Local graph, acquisition normalization and SDK acquisition call only",
        "prompt_change": "None; byte-identical prompts",
        "aggregate": aggregates,
        "episodes": rows,
    }


if __name__ == "__main__":
    result = compare()
    (HERE / "evidence/graph-shape-comparison.json").write_text(
        json.dumps(result, indent=2) + "\n"
    )
    for row in result["aggregate"]:
        print(json.dumps(row))
