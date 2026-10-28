"""Report over the frozen planned denominator, including errors and missing work."""
import json
import hashlib
from pathlib import Path
import sys


def summarize(directory):
    directory = Path(directory)
    manifest = json.loads((directory / "manifest.json").read_text())
    outcomes = []
    artifact_hashes = {}
    for run in range(1, manifest["runs"] + 1):
        for task in manifest["tasks"]:
            path = directory / f"run{run}" / f"{task}.json"
            row = {"task": task, "run": run, "status": "missing", "success": False}
            if path.exists():
                artifact_hashes[str(path.relative_to(directory))] = hashlib.sha256(path.read_bytes()).hexdigest()
                data = json.loads(path.read_text())
                scored = data.get("task_completion_pass") in (0, 1)
                row.update(status="scored" if scored else "unscored",
                           success=scored and data["task_completion_pass"] == 1,
                           ux=data.get("ux_score"), toolCalls=data.get("tool_calls"),
                           statePass=data.get("state_requirements_met"),
                           taskPass=data.get("task_requirements_met"))
            outcomes.append(row)
    usage = {key: 0 for key in ("inputTokens", "outputTokens", "cacheReadTokens", "cacheWriteTokens")}
    calls = 0
    dollars = 0.0
    for path in (directory / "agency-traces").glob("*.jsonl"):
        for line in path.read_text().splitlines():
            u = json.loads(line)["reply"]["usage"]
            calls += 1
            for key in usage:
                usage[key] += u[key]
            long = u["inputTokens"] + u["cacheReadTokens"] + u["cacheWriteTokens"] > 272000
            dollars += ((u["inputTokens"] * .1 + u["cacheReadTokens"] * .01 + u["cacheWriteTokens"] * .125) * (2 if long else 1)
                        + u["outputTokens"] * .5 * (1.5 if long else 1)) / 1e6
    successes = sum(row["success"] for row in outcomes)
    scored = sum(row["status"] == "scored" for row in outcomes)
    ux = [row["ux"] for row in outcomes if row.get("ux") is not None]
    return {"manifest": manifest, "planned": len(outcomes), "scored": scored,
            "executionNote": json.loads((directory / "execution-note.json").read_text()) if (directory / "execution-note.json").exists() else None,
            "trajectoryHashes": artifact_hashes,
            "missingOrUnscored": len(outcomes) - scored, "successes": successes,
            "successRateOverPlanned": successes / len(outcomes) if outcomes else None,
            "meanUx": sum(ux) / len(ux) if ux else None, "uxDenominator": len(ux),
            "observedAgentCalls": calls, "observedAgentUsage": usage,
            "observedAgentCostUsd": dollars, "totalExperimentCostUsd": None,
            "costLimit": "Observed agent calls only; simulator/judge costs and unreported failed-call usage excluded.",
            "outcomes": outcomes}


if __name__ == "__main__":
    print(json.dumps(summarize(sys.argv[1]), indent=2))
