"""Export aggregate evidence without redistributing task text or trajectories."""

import argparse
from collections import Counter, defaultdict
import hashlib
import json
from pathlib import Path
from statistics import mean

HERE = Path(__file__).resolve().parent


def summarize(run_names):
    all_rows = []
    configs = {}
    for name in run_names:
        root = HERE / ".local/runs" / name
        configs[name] = json.loads((root / "config.json").read_text())
        for file in sorted(root.glob("*/result.json")):
            row = json.loads(file.read_text())
            # Runtime/provider errors are not task failures, including older pilots.
            if row["error"]:
                row["success"] = None
            row["run"] = name
            api_path = file.parent / "api_calls.json"
            if api_path.exists():
                calls = json.loads(api_path.read_text())[row.get("setup_calls", 0) :]
                row["agent_api_categories"] = dict(
                    Counter(
                        "documentation"
                        if c["url"].startswith("/api_docs/")
                        else "supervisor"
                        if c["url"].startswith("/supervisor/")
                        else "application"
                        for c in calls
                    )
                )
            trace_path = file.parent / "trace.json"
            trace = (
                json.loads(trace_path.read_text())
                if trace_path.exists()
                else {"steps": []}
            )
            row["execution_errors"] = sum(
                s["output"].startswith(("Execution failed", "Invalid response"))
                for s in trace["steps"]
            )
            row["truncated_outputs"] = sum(
                len(s["output"]) > config_limit
                for s in trace["steps"]
                for config_limit in [configs[name].get("output_chars", 14000)]
            )
            row["projected_research_calls"] = sum(
                c.get("select") is not None for c in row["research_calls"]
            )
            row["attempted_traversal"] = any(
                c["op"] == "traverse" for c in row["research_calls"]
            )
            row["used_traversal"] = any(
                c["op"] == "traverse" and c.get("response_bytes") is not None
                for c in row["research_calls"]
            )
            row["failed_research_calls"] = sum(
                c.get("response_bytes") is None for c in row["research_calls"]
            )
            row["inference_seconds"] = sum(
                s["generation"].get("total_duration", 0) / 1e9 for s in trace["steps"]
            )
            row["prompt_cached_tokens"] = sum(
                s["generation"].get("prompt_eval_cached_count", 0)
                for s in trace["steps"]
            )
            row["trace_sha256"] = (
                hashlib.sha256((file.parent / "trace.json").read_bytes()).hexdigest()
                if (file.parent / "trace.json").exists()
                else None
            )
            all_rows.append(row)
    groups = defaultdict(list)
    for row in all_rows:
        groups[(row["run"], row["model"], row["condition"])].append(row)
    aggregate = []
    for (run, model, condition), rows in groups.items():
        valid = [r for r in rows if r["success"] is not None]
        calls = Counter(c["op"] for r in valid for c in r["research_calls"])
        aggregate.append(
            {
                "run": run,
                "model": model,
                "condition": condition,
                "completed_episodes": len(rows),
                "valid_episodes": len(valid),
                "infrastructure_errors": len(rows) - len(valid),
                "successes": sum(r["success"] for r in valid),
                "mean_steps": mean(r["steps"] for r in valid) if valid else None,
                "mean_prompt_tokens": mean(r["prompt_tokens"] for r in valid)
                if valid
                else None,
                "mean_generated_tokens": mean(r["generated_tokens"] for r in valid)
                if valid
                else None,
                "mean_source_calls": mean(r["source_calls"] for r in valid)
                if valid
                else None,
                "mean_agent_source_calls": mean(
                    r.get("agent_source_calls", r["source_calls"]) for r in valid
                )
                if valid
                else None,
                "mean_seconds": mean(r["seconds"] for r in valid) if valid else None,
                "research_operations": dict(calls),
            }
        )
    coverage = {}
    for name, config in configs.items():
        expected = {
            (task, condition, seed)
            for task in config["tasks"]
            for condition in config["conditions"]
            for seed in config["seeds"]
        }
        observed = {
            (r["task_id"], r["condition"], r["seed"])
            for r in all_rows
            if r["run"] == name
        }
        coverage[name] = {
            "expected": len(expected),
            "finished": len(observed),
            "complete": expected == observed,
            "missing": [list(x) for x in sorted(expected - observed)],
        }
    return {
        "configs": configs,
        "coverage": coverage,
        "episodes": all_rows,
        "aggregate": aggregate,
    }


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("runs", nargs="+")
    parser.add_argument("--output", default=".local/summary.json")
    args = parser.parse_args()
    report = summarize(args.runs)
    Path(args.output).write_text(json.dumps(report, indent=2) + "\n")
    for row in report["aggregate"]:
        print(json.dumps(row))
