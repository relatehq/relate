"""Summarize frozen explainer batches without exposing prompts or task answers."""

import json
import sys
from collections import Counter
from pathlib import Path
from statistics import mean

from retained_usage import episode_usage

root = Path(__file__).resolve().parent


def analyze(batch):
    ledger = json.loads(
        (root / ".local/explainer-batches" / batch / "ledger.json").read_text()
    )
    rows = []
    total = {"estimated_usd": 0, "attempted_requests": 0, "requests_without_usage": 0}
    for a in ledger["attempts"]:
        run = (
            Path(ledger["prepared"][a["arm"]]["checkout"])
            / "dev/research/appworld/.local/runs"
            / a["run"]
        )
        cases = list(run.glob("*__*__*"))
        usage = [episode_usage(case) for case in cases if case.is_dir()]
        for k in total:
            total[k] += sum(u[k] for u in usage)
        result = a.get("results", [])
        if len(result) == 1:
            r = result[0]
            row = {
                k: a[k] for k in ["candidate", "arm", "task", "repeat", "state", "run"]
            }
            row.update(
                {
                    k: r[k]
                    for k in [
                        "success",
                        "termination",
                        "steps",
                        "prompt_tokens",
                        "generated_tokens",
                        "estimated_usd",
                        "seconds",
                    ]
                }
            )
            row["valid"] = (
                a["state"] == "finished"
                and r["error"] is None
                and type(r["success"]) is bool
            )
            errors = Counter()
            for case in cases:
                path = case / "steps.json"
                if not path.exists():
                    continue
                for s in json.loads(path.read_text()):
                    if s.get("error"):
                        out = s.get("output", "")
                        kind = (
                            "redeclaration"
                            if "has already been declared" in out
                            else "read_error"
                            if "ReadError" in out
                            else "action_error"
                            if "ActionError" in out
                            else "other_error"
                        )
                        errors[kind] += 1
            row["error_turns"] = dict(errors)
            rows.append(row)
    result = {
        "batch": batch,
        "round": ledger["round"],
        "planned": ledger["planned_episodes"],
        "attempts": len(ledger["attempts"]),
        "finished": sum(a["state"] == "finished" for a in ledger["attempts"]),
        "usage": total,
        "comparisons": {},
        "episodes": rows,
    }
    expected = {
        (task, repeat)
        for task in ledger["tasks"]
        for repeat in range(ledger["repeats"])
    }
    for candidate in ledger["arms"]:
        if candidate == "baseline":
            continue
        paired = [r for r in rows if r["candidate"] == candidate]
        arms = {
            a: [r for r in paired if r["arm"] == a] for a in ["baseline", candidate]
        }
        eligible = all(
            len(rs) == len(expected)
            and {(r["task"], r["repeat"]) for r in rs} == expected
            and all(r["valid"] for r in rs)
            for rs in arms.values()
        )
        metrics = {
            a: {
                "n": len(rs),
                "successes": sum(r["success"] is True for r in rs),
                "mean_turns": mean(r["steps"] for r in rs) if rs else None,
                "mean_input_tokens": mean(r["prompt_tokens"] for r in rs)
                if rs
                else None,
            }
            for a, rs in arms.items()
        }
        gate = None
        if eligible:
            b, c = metrics["baseline"], metrics[candidate]
            efficient = (
                c["mean_turns"] <= 0.9 * b["mean_turns"]
                and c["mean_input_tokens"] <= 1.1 * b["mean_input_tokens"]
            ) or (
                c["mean_input_tokens"] <= 0.9 * b["mean_input_tokens"]
                and c["mean_turns"] <= 1.1 * b["mean_turns"]
            )
            gate = c["successes"] > b["successes"] or (
                c["successes"] == b["successes"] and efficient
            )
        result["comparisons"][candidate] = {
            "eligible": eligible,
            "gate": gate,
            "metrics": metrics,
        }
    return result


if __name__ == "__main__":
    x = analyze(sys.argv[1])
    print(json.dumps(x, indent=2))
