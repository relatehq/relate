"""Keep every selected task in the denominator, including setup/grader failures."""
import json
from pathlib import Path
import sys


def summarize(directory):
    directory = Path(directory)
    manifest = json.loads((directory / "manifest.json").read_text())
    outcomes = []
    for task in manifest["tasks"]:
        path = directory / task / "trial.json"
        trial = json.loads(path.read_text()) if path.exists() else {"status": "not-started"}
        score = trial.get("result", {}).get("final_score")
        fraction = None
        if trial["status"] == "scored" and score and score["total"] > 0:
            fraction = score["result"] / score["total"]
        outcomes.append({"task": task, "status": trial["status"], "score": fraction,
                         "agentStatus": trial.get("agentStatus"), "error": trial.get("error")})
    scored = [r for r in outcomes if r["score"] is not None]
    successes = sum(r["score"] == 1 for r in scored)
    return {"manifest": manifest, "planned": len(outcomes), "scored": len(scored),
            "unscored": len(outcomes) - len(scored), "fullyCompleted": successes,
            "completionLowerBoundOverPlanned": successes / len(outcomes) if outcomes else None,
            "partialCreditMeanOverScored": sum(r["score"] for r in scored) / len(scored) if scored else None,
            "outcomes": outcomes,
            "limit": "Unknown/unscored tasks are retained; the lower bound is not a completed benchmark result."}


if __name__ == "__main__":
    print(json.dumps(summarize(sys.argv[1]), indent=2))
