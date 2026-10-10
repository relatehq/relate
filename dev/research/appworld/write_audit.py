"""Sanitized diagnostic counts for the frozen write pilot, not an alternate scorer."""

import argparse
import json
import re
from collections import Counter
from pathlib import Path

HERE = Path(__file__).resolve().parent


def audit(name):
    rows = []
    for path in sorted((HERE / ".local/runs" / name).glob("*__*/result.json")):
        result = json.loads(path.read_text())
        steps = json.loads((path.parent / "steps.json").read_text())
        calls = json.loads((path.parent / "api_calls.json").read_text())
        evaluation = json.loads((path.parent / "evaluation.json").read_text())
        failures = evaluation.get("failures", [])
        passes = evaluation.get("passes", [])
        codes = [json.loads(s["content"]).get("code", "") for s in steps]
        endpoints = Counter()
        for call in calls:
            method, url = call["method"].upper(), call["url"]
            if method == "POST" and re.fullmatch(r"/venmo/transactions/\d+/likes", url):
                endpoints["like_attempts"] += 1
            if method == "POST" and re.fullmatch(
                r"/venmo/transactions/\d+/comments", url
            ):
                endpoints["comment_attempts"] += 1
        rows.append(
            {
                "trajectory_id": f"{name}/{path.parent.name}",
                "task_id": result["task_id"],
                "condition": result["condition"],
                "repeat": result["repeat"],
                "success": result["success"],
                "like_attempts": endpoints["like_attempts"],
                "evaluation_passed_checks": len(passes),
                "evaluation_failed_checks": len(failures),
                "failure_categories": sorted(
                    {
                        "answer"
                        if f["requirement"] == "assert answers match."
                        else "world-state"
                        for f in failures
                    }
                ),
                "write_state_checks_passed": (
                    all(f["requirement"] == "assert answers match." for f in failures)
                    if result["task_id"].startswith("afc0fce_")
                    else None
                ),
                "comment_attempts": endpoints["comment_attempts"],
                "action_error_turns": sum("ActionError:" in s["output"] for s in steps),
                "literal_status_only_turns": sum(
                    bool(
                        re.fullmatch(
                            "\\s*(?:print|console\\.log)\\(\\s*(?:\"(?:[^\"\\\\\\n]|\\\\.)*\"|'(?:[^'\\\\\\n]|\\\\.)*')\\s*\\)\\s*;?\\s*",
                            c,
                        )
                    )
                    for c in codes
                ),
                "sdk_action_mention_turns": sum("relate.actions" in c for c in codes),
                "notes": "API counts are attempts in the original request tracker, not proof of successful mutations. Literal-only print detection is conservative and syntactic.",
            }
        )
    return rows


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("run")
    parser.add_argument("--output", required=True, type=Path)
    args = parser.parse_args()
    args.output.write_text(json.dumps(audit(args.run), indent=2) + "\n")
    print(f"{len(audit(args.run))} episode diagnostics")
