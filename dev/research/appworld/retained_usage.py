"""Account for retained requests independently of finished benchmark results."""

import json


def read_json(path, default):
    return json.loads(path.read_text()) if path.exists() else default


def episode_usage(case):
    steps = read_json(case / "steps.json", [])
    requests = read_json(case / "requests.json", [])
    result = read_json(case / "result.json", {})
    # A response can be saved just before the request journal is updated.
    attempts = max(len(requests), len(steps), result.get("steps", 0))
    unknown = max(0, attempts - len(steps))
    return {
        "attempted_requests": attempts,
        "requests_without_usage": unknown,
        "estimated_usd": max(
            sum(s["model"]["estimated_usd"] for s in steps),
            result.get("estimated_usd", 0),
        ),
        "prompt_tokens": max(
            sum(s["model"]["usage"]["input_tokens"] for s in steps),
            result.get("prompt_tokens", 0),
        ),
        "generated_tokens": max(
            sum(s["model"]["usage"]["output_tokens"] for s in steps),
            result.get("generated_tokens", 0),
        ),
    }


def arm_status(root, config):
    cases = sorted(p for p in root.glob("*__*__*") if p.is_dir())
    results = [read_json(p / "result.json", {}) for p in cases]
    expected = {
        (t, c, r)
        for t in config["tasks"]
        for c in config["conditions"]
        for r in range(config["repeats"])
    }
    observed = {(r["task_id"], r["condition"], r["repeat"]) for r in results if r}
    usage = [episode_usage(p) for p in cases]
    return {
        "completed_episodes": sum(bool(r) for r in results),
        "expected_episodes": len(expected),
        "comparison_eligible": (
            len(results) == len(expected) == 12
            and observed == expected
            and all(
                r
                and r.get("error") is None
                and r["condition"] == "sdk"
                and r.get("success") is not None
                for r in results
            )
        ),
        **{
            key: sum(u[key] for u in usage)
            for key in [
                "attempted_requests",
                "requests_without_usage",
                "estimated_usd",
                "prompt_tokens",
                "generated_tokens",
            ]
        },
    }


def code_from_step(step):
    try:
        value = json.loads(step["content"])
        return value.get("code", "") if isinstance(value, dict) else ""
    except (ValueError, TypeError):
        return ""
