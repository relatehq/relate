"""Sanitized expanded-subset analysis, with separate like-for-like results."""

import hashlib
import json
import re
import subprocess
from pathlib import Path
from statistics import mean

from budget_compare import annotate
from prompts import prompt

HERE = Path(__file__).resolve().parent
BASELINE = "sdk-nano-contact-graph-v1"
CANDIDATE = "sdk-nano-queries-v1"
MAIN = "2cf7f92"
CONDITIONS = ["raw", "raw_ts", "sdk"]
ORIGINAL = ["afc0fce_1", "afc0fce_2", "d0b1f43_1"]
ADDED = ["afc0fce_3", "e7a10f8_3", "82e2fac_1"]


def aggregate(rows, run, cohort, condition):
    es = [r for r in rows if r["condition"] == condition]
    writes = [r for r in es if r["task_id"].startswith("afc0fce_")]
    reads = [r for r in es if r not in writes]
    successes = [r for r in es if r["success"]]
    return {
        "run": run,
        "cohort": cohort,
        "condition": condition,
        "episodes": len(es),
        "success": sum(r["success"] for r in es),
        "writes": len(writes),
        "write_success": sum(r["success"] for r in writes),
        "reads": len(reads),
        "read_success": sum(r["success"] for r in reads),
        "correct_write_state": sum(r["write_state_checks_passed"] for r in writes),
        "write_answer_failures": sum(
            "answer" in r["failure_categories"] for r in writes
        ),
        "completed": sum(r["completed"] for r in es),
        **{
            "mean_" + k: mean(r[k] for r in es)
            for k in ["steps", "seconds", "prompt_tokens", "generated_tokens"]
        },
        **{
            "successful_mean_" + k: mean(r[k] for r in successes) if successes else None
            for k in ["steps", "prompt_tokens", "generated_tokens"]
        },
        "seconds": sum(r["seconds"] for r in es),
        "estimated_usd": sum(r["estimated_usd"] for r in es),
    }


def compare():
    configs = {
        n: json.loads((HERE / ".local/runs" / n / "config.json").read_text())
        for n in [BASELINE, CANDIDATE]
    }
    old, new = configs[BASELINE], configs[CANDIDATE]
    differences = sorted(k for k in old.keys() | new.keys() if old.get(k) != new.get(k))
    assert differences == ["git_head", "run", "source_sha256", "tasks"], differences
    assert old["tasks"] == ORIGINAL and new["tasks"] == ORIGINAL + ADDED
    assert old["prompts"] == new["prompts"] and new["conditions"] == CONDITIONS
    assert new["steps"] == 28 and new["repeats"] == 2 and not new["completion_feedback"]
    changed = [
        k
        for k in old["source_sha256"]
        if old["source_sha256"][k] != new["source_sha256"][k]
    ]
    assert changed == ["sdk-graph.mjs"], changed
    assert (
        subprocess.check_output(
            [
                "git",
                "diff",
                "--name-only",
                MAIN,
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
    rows = {}
    for name, config in configs.items():
        root = HERE / ".local/runs" / name
        for filename, digest in config["source_sha256"].items():
            assert (
                hashlib.sha256((root / "source" / filename).read_bytes()).hexdigest()
                == digest
            )
        rows[name] = annotate(name)
        expected = {
            (t, c, r) for t in config["tasks"] for c in CONDITIONS for r in range(2)
        }
        assert {
            (r["task_id"], r["condition"], r["repeat"]) for r in rows[name]
        } == expected
        for row in rows[name]:
            case = HERE / ".local/runs" / row["trajectory_id"]
            assert row["success"] is not None and row["error_category"] is None
            messages = json.loads((case / "initial_messages.json").read_text())
            assert (
                messages[0]["content"]
                == config["prompts"][row["condition"]]
                == prompt(row["condition"])
            )
            steps = json.loads((case / "steps.json").read_text())
            assert len(steps) == row["steps"] <= 28
            for field, usage in [
                ("prompt_tokens", "input_tokens"),
                ("generated_tokens", "output_tokens"),
            ]:
                assert row[field] == sum(s["model"]["usage"][usage] for s in steps)
            assert (
                abs(
                    row["estimated_usd"]
                    - sum(s["model"]["estimated_usd"] for s in steps)
                )
                < 1e-10
            )
            codes = [json.loads(s["content"]).get("code", "") for s in steps]
            row["operator_code_turns"] = [
                s["turn"]
                for s, c in zip(steps, codes)
                if re.search(r"\b(?:eq|in|gt|gte|lt|lte)\s*:", c)
            ]
            row["contact_relationship_code_turns"] = [
                s["turn"]
                for s, c in zip(steps, codes)
                if "ContactRelationship" in c or "contactRelationships" in c
            ]
            row["read_error_turns"] = [
                s["turn"] for s in steps if "ReadError:" in s["output"]
            ]
            row["cohort"] = "original" if row["task_id"] in ORIGINAL else "added"
    old_by_case = {
        (r["task_id"], r["condition"], r["repeat"]): r for r in rows[BASELINE]
    }
    matched = []
    for row in rows[CANDIDATE]:
        key = (row["task_id"], row["condition"], row["repeat"])
        if key not in old_by_case:
            continue
        previous = old_by_case[key]
        assert row["acquisition_calls"] == previous["acquisition_calls"]
        a = HERE / ".local/runs" / previous["trajectory_id"] / "initial_messages.json"
        b = HERE / ".local/runs" / row["trajectory_id"] / "initial_messages.json"
        assert json.loads(a.read_text()) == json.loads(b.read_text())
        if row["success"] and previous["success"]:
            matched.append(
                {
                    "case": "/".join(map(str, key)),
                    "condition": row["condition"],
                    "before": {
                        k: previous[k]
                        for k in [
                            "steps",
                            "prompt_tokens",
                            "generated_tokens",
                            "seconds",
                        ]
                    },
                    "after": {
                        k: row[k]
                        for k in [
                            "steps",
                            "prompt_tokens",
                            "generated_tokens",
                            "seconds",
                        ]
                    },
                }
            )
    aggregates = []
    for name, episodes in rows.items():
        for cohort in (
            ["original"] if name == BASELINE else ["all", "original", "added"]
        ):
            group = [r for r in episodes if cohort == "all" or r["cohort"] == cohort]
            for c in CONDITIONS:
                aggregates.append(aggregate(group, name, cohort, c))
    return {
        "baseline": BASELINE,
        "candidate": CANDIDATE,
        "merged_main": MAIN,
        "config_difference_fields": differences,
        "sdk_matches_merged_main": True,
        "prompts_identical": True,
        "execution_source_change": "Graph descriptions from 334db11 only; SDK package changes come from main",
        "aggregate": aggregates,
        "matched_successes": matched,
        "episodes": rows,
    }


if __name__ == "__main__":
    result = compare()
    (HERE / "evidence/queries-comparison.json").write_text(
        json.dumps(result, indent=2) + "\n"
    )
    for row in result["aggregate"]:
        print(json.dumps(row))
