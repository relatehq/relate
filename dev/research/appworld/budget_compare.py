"""Compare retained turn-budget runs without publishing protected trace contents."""

import argparse
import json
import re
from pathlib import Path
from statistics import mean

from write_audit import audit

HERE = Path(__file__).resolve().parent


def mutation_kind(call):
    if call["method"].upper() != "POST":
        return None
    match = re.fullmatch(r"/venmo/transactions/\d+/(likes|comments)", call["url"])
    return match.group(1) if match else None


def annotate(name):
    diagnostics = {r["trajectory_id"]: r for r in audit(name)}
    rows = []
    for path in sorted((HERE / ".local/runs" / name).glob("*__*/result.json")):
        result = json.loads(path.read_text())
        steps = json.loads((path.parent / "steps.json").read_text())
        calls = json.loads((path.parent / "api_calls.json").read_text())
        offset = result["setup_calls"] + result["acquisition_calls"]
        # Assert the accounting before assigning requests to turns. In this
        # AppWorld version host completion polling records no API requests.
        assert len(calls) == offset + sum(s["api_calls"] for s in steps), (
            path.parent.name
        )
        turns = []
        for step in steps:
            cell_calls = calls[offset : offset + step["api_calls"]]
            offset += step["api_calls"]
            turns.append(
                {
                    "turn": step["turn"],
                    "like_attempts": sum(
                        mutation_kind(c) == "likes" for c in cell_calls
                    ),
                    "comment_attempts": sum(
                        mutation_kind(c) == "comments" for c in cell_calls
                    ),
                }
            )
        mutation_turns = [
            t["turn"] for t in turns if t["like_attempts"] + t["comment_attempts"]
        ]
        late = [s for s in steps if s["turn"] > 14]
        diagnostic = diagnostics[f"{name}/{path.parent.name}"]
        rows.append(
            {
                **{
                    k: result[k]
                    for k in [
                        "task_id",
                        "condition",
                        "repeat",
                        "success",
                        "completed",
                        "termination",
                        "steps",
                        "seconds",
                        "prompt_tokens",
                        "cached_tokens",
                        "generated_tokens",
                        "model_seconds",
                        "setup_seconds",
                        "acquisition_seconds",
                        "source_calls",
                        "acquisition_calls",
                        "agent_source_calls",
                        "estimated_usd",
                    ]
                },
                **diagnostic,
                "error_category": result["error"].split(":", 1)[0]
                if result["error"]
                else None,
                "resolved_models": sorted({s["model"]["model"] for s in steps}),
                "first_mutation_turn": min(mutation_turns) if mutation_turns else None,
                "mutation_turns": turns,
                "used_turns_after_14": len(late),
                "succeeded_after_turn_14": result["success"] is True
                and result["steps"] > 14,
                "post_14_input_tokens": sum(
                    s["model"]["usage"]["input_tokens"] for s in late
                ),
                "post_14_output_tokens": sum(
                    s["model"]["usage"]["output_tokens"] for s in late
                ),
                "post_14_model_seconds": sum(s["model"]["seconds"] for s in late),
                "post_14_execution_seconds": sum(s["execution_seconds"] for s in late),
                "post_14_estimated_usd": sum(s["model"]["estimated_usd"] for s in late),
                "redeclaration_error_turns": sum(
                    "has already been declared" in s["output"] for s in steps
                ),
                "non_iterable_error_turns": sum(
                    "not async iterable" in s["output"] or "not iterable" in s["output"]
                    for s in steps
                ),
                "output_truncation_turns": sum(
                    "[OUTPUT TRUNCATED:" in s["visible_output"] for s in steps
                ),
            }
        )
    return rows


def compare(baseline, candidate):
    configs = {
        n: json.loads((HERE / ".local/runs" / n / "config.json").read_text())
        for n in [baseline, candidate]
    }
    old, new = configs[baseline], configs[candidate]
    differences = {
        k: [old.get(k), new.get(k)]
        for k in set(old) | set(new)
        if old.get(k) != new.get(k)
    }
    assert set(differences) <= {"run", "steps", "git_head"}, sorted(differences)
    assert old["steps"] == 14 and new["steps"] == 28
    annotated = {n: annotate(n) for n in configs}
    summaries = []
    for name, rows in annotated.items():
        for condition in configs[name]["conditions"]:
            selected = [r for r in rows if r["condition"] == condition]
            if not selected:
                continue
            writes = [r for r in selected if r["task_id"].startswith("afc0fce_")]
            reads = [r for r in selected if not r["task_id"].startswith("afc0fce_")]
            summaries.append(
                {
                    "run": name,
                    "condition": condition,
                    "episodes": len(selected),
                    "official_successes": sum(r["success"] is True for r in selected),
                    "write_successes": sum(r["success"] is True for r in writes),
                    "read_successes": sum(r["success"] is True for r in reads),
                    "write_state_checks_passed": sum(
                        r["write_state_checks_passed"] is True for r in writes
                    ),
                    "write_episodes_with_mutation_requests": sum(
                        r["first_mutation_turn"] is not None for r in writes
                    ),
                    "successes_after_turn_14": sum(
                        r["succeeded_after_turn_14"] for r in selected
                    ),
                    "episodes_using_turns_after_14": sum(
                        r["used_turns_after_14"] > 0 for r in selected
                    ),
                    "completed": sum(r["completed"] for r in selected),
                    "mean_turns": mean(r["steps"] for r in selected),
                    "mean_seconds": mean(r["seconds"] for r in selected),
                    "mean_input_tokens": mean(r["prompt_tokens"] for r in selected),
                    "mean_output_tokens": mean(r["generated_tokens"] for r in selected),
                    "total_seconds": sum(r["seconds"] for r in selected),
                    "estimated_usd": sum(r["estimated_usd"] for r in selected),
                    "post_14_estimated_usd": sum(
                        r["post_14_estimated_usd"] for r in selected
                    ),
                }
            )
    return {
        "baseline": baseline,
        "candidate": candidate,
        "config_differences": differences,
        "identical_source_hashes": old["source_sha256"] == new["source_sha256"],
        "identical_prompts": old["prompts"] == new["prompts"],
        "summaries": summaries,
        "episodes": annotated,
        "caveat": "Fresh stochastic episodes, not continuations of a common prefix. Matching task/method/repeat does not control provider sampling or graph IDs. World-state diagnostics do not replace official scores.",
    }


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--baseline", default="sdk-nano-writes-v1")
    parser.add_argument("--candidate", default="sdk-nano-writes-28-v1")
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    result = compare(args.baseline, args.candidate)
    args.output.write_text(json.dumps(result, indent=2) + "\n")
    print(json.dumps(result["summaries"], indent=2))
