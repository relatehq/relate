"""Export SDK-study measurements without benchmark text, answers or credentials."""

import argparse
import hashlib
import json
from collections import Counter, defaultdict
from pathlib import Path
from statistics import mean

HERE = Path(__file__).resolve().parent


def summarize(names):
    episodes, coverage, configs = [], {}, {}
    for name in names:
        root = HERE / ".local/runs" / name
        config = json.loads((root / "config.json").read_text())
        configs[name] = config
        expected = {
            (t, c, r)
            for t in config["tasks"]
            for c in config["conditions"]
            for r in range(config["repeats"])
        }
        observed = set()
        for path in sorted(root.glob("*/result.json")):
            row = json.loads(path.read_text())
            # Never expose arbitrary exception strings: provider errors may echo
            # inputs. Public evidence reports the category only.
            row["error"] = row["error"].split(":", 1)[0] if row["error"] else None
            row["run"] = name
            row["study_role"] = (
                "explicit-no-answer-comparison"
                if name == "sdk-nano-no-answer-v1"
                else "write-turn-budget-comparison"
                if name == "sdk-nano-writes-28-v1"
                else "write-action-pilot"
                if name == "sdk-nano-writes-v1"
                else "uniform-raw-ts-comparison"
                if name == "sdk-nano-uniform-ts-v1"
                else "nano-discovery-rerun"
                if name == "sdk-nano-discovery-v1"
                else "primary"
                if name == "sdk-mini-main-v3"
                else "completion-feedback-ablation"
                if name == "sdk-mini-completion-feedback-v1"
                else "nano-corrected-pilot"
                if name == "sdk-nano-tool-pilot-v2"
                else "superseded-diagnostic"
            )
            observed.add((row["task_id"], row["condition"], row["repeat"]))
            steps_path = path.parent / "steps.json"
            steps = json.loads(steps_path.read_text()) if steps_path.exists() else []
            row["trace_sha256"] = (
                hashlib.sha256(steps_path.read_bytes()).hexdigest()
                if steps_path.exists()
                else None
            )
            row["incomplete_model_responses"] = sum(
                s["model"]["status"] != "completed" for s in steps
            )
            row["cell_errors"] = sum(
                bool(s.get("error"))
                or s["output"].startswith(("Execution failed", "Invalid response"))
                for s in steps
            )
            row["truncated_outputs"] = sum(
                len(s["output"]) > config["output_chars"] for s in steps
            )
            row["resolved_models"] = sorted({s["model"]["model"] for s in steps})
            row["reasoning_tokens"] = sum(
                s["model"]["usage"]
                .get("output_tokens_details", {})
                .get("reasoning_tokens", 0)
                for s in steps
            )
            # Syntactic mentions are only an audit aid, never successful-call counts.
            row["sdk_code_mentions"] = {
                term: sum(term in s["content"] for s in steps)
                for term in [".describe(", ".query(", ".traverse.", ".get("]
            }
            calls = json.loads((path.parent / "api_calls.json").read_text())
            row["all_api_categories"] = dict(
                Counter(
                    "documentation"
                    if c["url"].startswith("/api_docs/")
                    else "supervisor"
                    if c["url"].startswith("/supervisor/")
                    else "application"
                    for c in calls
                )
            )
            row["evaluation_valid"] = not (
                name in {"sdk-nano-pilot-v1", "sdk-mini-pilot-v1"}
                and row["condition"] == "sdk"
            )
            if not row["evaluation_valid"]:
                row["unreliable_pilot_evaluator_success"] = row["success"]
                row["success"] = None
            episodes.append(row)
        coverage[name] = {
            "expected": len(expected),
            "finished": len(observed),
            "complete": observed == expected,
            "missing": [list(x) for x in sorted(expected - observed)],
        }
    grouped = defaultdict(list)
    for row in episodes:
        grouped[row["run"], row["model"], row["condition"]].append(row)
    aggregates = []
    for (run, model, condition), rows in grouped.items():
        valid = [r for r in rows if r["success"] is not None]
        a = {
            "run": run,
            "model": model,
            "condition": condition,
            "finished": len(rows),
            "valid": len(valid),
            "successes": sum(r["success"] for r in valid),
        }
        for field in [
            "steps",
            "prompt_tokens",
            "cached_tokens",
            "generated_tokens",
            "reasoning_tokens",
            "seconds",
            "setup_seconds",
            "acquisition_seconds",
            "model_seconds",
            "source_calls",
            "agent_source_calls",
            "acquisition_calls",
            "cell_errors",
            "truncated_outputs",
        ]:
            a["mean_" + field] = mean(r[field] for r in valid) if valid else None
        a["estimated_usd"] = sum(r["estimated_usd"] for r in rows)
        aggregates.append(a)
    return {
        "configs": configs,
        "coverage": coverage,
        "episodes": episodes,
        "aggregate": aggregates,
        "notes": [
            "SDK pilot-v1 scores excluded: evaluator read initial disk state; fixed and regression-tested before v2.",
            "SDK code mentions are syntactic trace indicators, not counts of successful operations.",
            "All API categories exclude authentication only when explicitly stated; source_calls excludes host completion polling.",
        ],
    }


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("runs", nargs="+")
    parser.add_argument("--output", required=True, type=Path)
    args = parser.parse_args()
    report = summarize(args.runs)
    args.output.write_text(json.dumps(report, indent=2) + "\n")
    for row in report["aggregate"]:
        print(json.dumps(row))
