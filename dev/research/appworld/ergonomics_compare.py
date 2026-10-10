"""Compare independent SDK/graph spikes using sanitized episode evidence."""

import hashlib
import json
import re
import subprocess
from collections import Counter
from pathlib import Path
from statistics import mean

from budget_compare import annotate

HERE = Path(__file__).resolve().parent
PREFIX = "sdk-nano-ergonomics-"
ARMS = {
    "baseline": "Unchanged control",
    "receipts": "SDK action receipt discovery",
    "errors": "SDK request error messages",
    "query": "SDK query consumption examples",
    "contacts": "Graph contact descriptions",
    "dates": "Graph date description",
}
MAIN = "2cf7f9283d807ec83e183895cf2e8141ba045ca3"


def turn_kind(step):
    code = json.loads(step["content"]).get("code", "")
    output = step["output"]
    if step["error"]:
        if "has already been declared" in output:
            return "redeclaration"
        if "ReadError:" in output:
            return "read_error"
        if "ActionError:" in output:
            return "action_error"
        return "other_error"
    if "completeTask(" in code:
        return "completion"
    if re.fullmatch(
        r"""\s*(?:console\.log\(\s*(?:'(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*")\s*\)\s*;?\s*)+""",
        code,
        re.DOTALL,
    ):
        return "literal_print"
    if ".describe(" in code:
        return "discovery"
    if "relate.actions." in code:
        return "actions"
    if "relate.objects." in code:
        return "reads"
    return "local_computation"


def metrics(rows):
    successes = [r for r in rows if r["success"]]
    writes = [r for r in rows if r["task_id"].startswith("afc0fce_")]
    return {
        "episodes": len(rows),
        "success": len(successes),
        "write_success": sum(r["success"] for r in writes),
        "write_state_success": sum(
            r["write_state_checks_passed"] is True for r in writes
        ),
        "read_success": sum(r["success"] for r in rows if r not in writes),
        "mean_turns": mean(r["steps"] for r in rows),
        "mean_input_tokens": mean(r["prompt_tokens"] for r in rows),
        "mean_output_tokens": mean(r["generated_tokens"] for r in rows),
        "mean_seconds": mean(r["seconds"] for r in rows),
        "estimated_usd": sum(r["estimated_usd"] for r in rows),
        "date_range_error_turns": sum(len(r["date_range_error_turns"]) for r in rows),
        "query_page_error_turns": sum(len(r["query_page_error_turns"]) for r in rows),
        "action_validation_turns": sum(len(r["action_validation_turns"]) for r in rows),
        "turns": sum(r["steps"] for r in rows),
        "seconds": sum(r["seconds"] for r in rows),
        "turn_categories": dict(
            sum((Counter(r["turn_categories"]) for r in rows), Counter())
        ),
        "successful_mean_turns": mean(r["steps"] for r in successes)
        if successes
        else None,
        "successful_mean_input_tokens": mean(r["prompt_tokens"] for r in successes)
        if successes
        else None,
    }


def improvement(candidate, baseline):
    """Frozen screening rule; never a significance test."""
    if candidate["success"] != baseline["success"]:
        return candidate["success"] > baseline["success"]
    turns = candidate["mean_turns"] / baseline["mean_turns"]
    tokens = candidate["mean_input_tokens"] / baseline["mean_input_tokens"]
    return (turns <= 0.9 and tokens <= 1.1) or (tokens <= 0.9 and turns <= 1.1)


def analyze():
    runs = {}
    baseline = json.loads(
        (HERE / ".local/runs" / (PREFIX + "baseline-v1") / "config.json").read_text()
    )
    for root in sorted((HERE / ".local/runs").glob(PREFIX + "*")):
        config = json.loads((root / "config.json").read_text())
        paths = list(root.glob("*/result.json"))
        if len(paths) != 12:
            continue
        for key, value in baseline.items():
            if key not in {"run", "git_head", "source_sha256"}:
                assert config[key] == value, (root.name, key)
        for filename, digest in config["source_sha256"].items():
            assert (
                hashlib.sha256((root / "source" / filename).read_bytes()).hexdigest()
                == digest
            )
        changed_sources = [
            k
            for k in baseline["source_sha256"]
            if baseline["source_sha256"][k] != config["source_sha256"][k]
        ]
        graph_arm = any(x in root.name for x in ["contacts", "dates"])
        assert changed_sources == (["sdk-graph.mjs"] if graph_arm else [])
        rows = annotate(root.name)
        assert len({(r["task_id"], r["repeat"]) for r in rows}) == 12
        assert all(
            r["error_category"] is None and r["condition"] == "sdk" for r in rows
        )
        treatment_exposures = Counter()
        for row in rows:
            case = HERE / ".local/runs" / row["trajectory_id"]
            steps = json.loads((case / "steps.json").read_text())
            for step in steps:
                for treatment, marker in {
                    "query": "everyPage:",
                    "receipts": "A new key is a new invocation and can repeat external effects",
                    "errors": "Accepted: eq, in.",
                    "contacts": "match both owner and kind",
                    "dates": "This property supports eq/in filters, not range operators",
                }.items():
                    if marker in step["output"]:
                        assert f"-{treatment}-" in root.name, (root.name, treatment)
                        treatment_exposures[treatment] += 1
            row["turn_categories"] = dict(Counter(turn_kind(s) for s in steps))
            row["date_range_error_turns"] = [
                s["turn"]
                for s in steps
                if "where.createdAt." in s["output"]
                and "unsupported filter" in s["output"]
            ]
            row["query_page_error_turns"] = [
                s["turn"] for s in steps if "not async iterable" in s["output"]
            ]
            row["action_validation_turns"] = [
                s["turn"]
                for s in steps
                if "ActionError: invalid" in s["output"]
                or ("relate.actions." in s["content"] and " invalid" in s["output"])
            ]
            for field, key in [
                ("prompt_tokens", "input_tokens"),
                ("generated_tokens", "output_tokens"),
            ]:
                assert row[field] == sum(s["model"]["usage"][key] for s in steps)
        patch_path = root / "sdk-implementation.patch"
        try:
            implementation = subprocess.check_output(
                [
                    "git",
                    "diff",
                    MAIN,
                    config["git_head"],
                    "--",
                    "packages",
                    "apps/docs/content/runtime/discovery.md",
                ],
                cwd=HERE.parents[2],
                stderr=subprocess.DEVNULL,
            )
            if patch_path.exists():
                assert patch_path.read_bytes() == implementation
            else:
                patch_path.write_bytes(implementation)
        except subprocess.CalledProcessError:
            # Negative spike branches need not be published. The encrypted
            # archive retains their exact patch, whose hash is public evidence.
            implementation = patch_path.read_bytes()
        package_diff = [
            name
            for name in re.findall(
                r"^diff --git a/(.*?) b/", implementation.decode(), re.MULTILINE
            )
            if name.startswith("packages/")
        ]
        runs[root.name] = {
            "git_head": config["git_head"],
            "sdk_patch_sha256": hashlib.sha256(implementation).hexdigest()
            if implementation
            else None,
            "package_diff": package_diff,
            "changed_execution_sources": changed_sources,
            "treatment_exposure_turns": dict(treatment_exposures),
            "metrics": metrics(rows),
            "episodes": rows,
        }
    control = runs.get(PREFIX + "baseline-v1")
    if control:
        for name, run in runs.items():
            run["screening_improvement"] = (
                improvement(run["metrics"], control["metrics"])
                if name.endswith("-v1") and name != PREFIX + "baseline-v1"
                else None
            )
    comparisons = {}
    for arm in ARMS:
        if arm == "baseline":
            continue
        candidates = [
            runs[PREFIX + arm + "-" + v]
            for v in ["v1", "v2"]
            if PREFIX + arm + "-" + v in runs
        ]
        controls = [
            runs[PREFIX + "baseline-" + v]
            for v in ["v1", "v2"]
            if PREFIX + arm + "-" + v in runs and PREFIX + "baseline-" + v in runs
        ]
        if not candidates or len(candidates) != len(controls):
            continue
        a = [r for run in controls for r in run["episodes"]]
        b = [r for run in candidates for r in run["episodes"]]
        pairs = [
            (x, y)
            for control_run, candidate_run in zip(controls, candidates, strict=True)
            for x in control_run["episodes"]
            for y in candidate_run["episodes"]
            if (x["task_id"], x["repeat"]) == (y["task_id"], y["repeat"])
            and x["success"]
            and y["success"]
        ]
        am, bm = metrics(a), metrics(b)
        confirmed = len(candidates) == 2
        comparisons[arm] = {
            "rounds": len(candidates),
            "control": am,
            "candidate": bm,
            "confirmation_accuracy_not_lower": candidates[-1]["metrics"]["success"]
            >= controls[-1]["metrics"]["success"]
            if confirmed
            else None,
            "promote": confirmed
            and candidates[-1]["metrics"]["success"]
            >= controls[-1]["metrics"]["success"]
            and improvement(bm, am),
            "matched_successful_cases": len(pairs),
            "matched_successful_turns": {
                "control": mean(x["steps"] for x, y in pairs),
                "candidate": mean(y["steps"] for x, y in pairs),
            }
            if pairs
            else None,
            "matched_successful_input_tokens": {
                "control": mean(x["prompt_tokens"] for x, y in pairs),
                "candidate": mean(y["prompt_tokens"] for x, y in pairs),
            }
            if pairs
            else None,
        }
    return {
        "comparisons": comparisons,
        "main": MAIN,
        "arms": ARMS,
        "runs": runs,
        "estimated_usd": sum(r["metrics"]["estimated_usd"] for r in runs.values()),
    }


if __name__ == "__main__":
    result = analyze()
    (HERE / "evidence/ergonomics.json").write_text(json.dumps(result, indent=2) + "\n")
    for name, run in result["runs"].items():
        print(
            name, json.dumps(run["metrics"]), "qualifies", run["screening_improvement"]
        )
