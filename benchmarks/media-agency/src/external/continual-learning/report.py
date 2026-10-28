"""Summarize each task separately; rewards have different units across tasks."""
import gzip
import hashlib
import json
from pathlib import Path
import sys


def summarize_trial(directory):
    directory = Path(directory)
    manifest = json.loads((directory / "agency-manifest.json").read_text())
    artifacts = list(directory.glob("upstream-results/results/*/viewer_artifact_*.json.gz"))
    row = {"manifest": manifest, "status": "unscored", "runs": []}
    if not artifacts:
        return row
    if len(artifacts) != 1:
        raise ValueError("Ambiguous viewer artifacts")
    artifact = artifacts[0]
    summary = json.loads(gzip.decompress(artifact.read_bytes()))["summary"]
    row.update(status=summary["status"], task=summary["task"], schedule=summary["schedule"],
               artifact=str(artifact.relative_to(directory)), artifactSha256=hashlib.sha256(artifact.read_bytes()).hexdigest())
    baseline = summary.get("baseline") or {}
    execution = baseline.get("execution", {})
    outcomes = baseline.get("instance_outcomes", [])
    row["baseline"] = {"status": baseline.get("status"),
        "planned": execution.get("instances_total"), "completed": execution.get("instances_completed"),
        "blocked": execution.get("instances_blocked"),
        "usage": execution.get("usage", {}).get("interaction", {}),
        "totalReward": sum(o.get("reward", 0) for o in outcomes)}
    for run in summary["runs"]:
        execution = run.get("execution", {})
        row["runs"].append({"index": run["run_index"], "status": run["status"], "score": run["score"],
            "planned": execution.get("instances_total"), "completed": execution.get("instances_completed"),
            "blocked": execution.get("instances_blocked"), "aggregate": run["aggregate"],
            "usage": execution.get("usage", {}).get("interaction", {})})
    return row


def summarize_suite(directory):
    directory = Path(directory)
    manifest = json.loads((directory / "suite.json").read_text())
    rows = {}
    for task, state in manifest["tasks"].items():
        trial = directory / task
        rows[task] = {"process": state, **(summarize_trial(trial) if (trial / "agency-manifest.json").exists()
                                        else {"status": "not-started", "runs": []})}
    return {"suite": manifest, "tasks": rows, "limit": "One run per default schedule; no cross-task reward average. Unscored and blocked tasks remain listed."}


if __name__ == "__main__":
    print(json.dumps(summarize_suite(sys.argv[1]), indent=2))
