"""Reports retain planned denominators and never silently drop failed trials."""

import json
from collections import defaultdict
from math import comb
from pathlib import Path

from inspect_ai.log import read_eval_log


def reliability(outcomes, k):
    """Unbiased pass@k and all-k-success estimates; undefined when n < k."""
    n, c = len(outcomes), sum(outcomes)
    if n < k:
        return {"pass_at_k": None, "pass_power_k": None}
    return {
        "pass_at_k": 1 - (comb(n - c, k) / comb(n, k) if n - c >= k else 0),
        "pass_power_k": comb(c, k) / comb(n, k) if c >= k else 0,
    }


def summarize(manifest, observed):
    planned = {(x["agent"], x["task"], x["epoch"]): x for x in manifest["schedule"]}
    found = {}
    for row in observed:
        key = row["agent"], row["task"], row["epoch"]
        if key not in planned or key in found:
            raise ValueError(
                f"Unexpected or duplicate trial: {key}; retries belong in a new run"
            )
        found[key] = row
    rows = [
        found.get(
            key,
            {
                **plan,
                "status": "missing",
                "success": False,
                "input_tokens": 0,
                "output_tokens": 0,
            },
        )
        for key, plan in planned.items()
    ]
    groups = defaultdict(list)
    for row in rows:
        plan = planned[row["agent"], row["task"], row["epoch"]]
        row.update(family=plan["family"], level=plan["level"])
        for slice_ in ("all", f"level:{row['level']}", f"family:{row['family']}"):
            groups[row["agent"], slice_].append(row)
    slices = []
    for (agent, slice_), values in sorted(groups.items()):
        complete = [r for r in values if r["status"] == "scored"]
        per_task = defaultdict(list)
        for r in values:
            per_task[r["task"]].append(r)
        repeated = [
            rs for rs in per_task.values() if all(r["status"] == "scored" for r in rs)
        ]
        repeats = {}
        for k in (1, 2, 3):
            eligible = [rs for rs in repeated if len(rs) >= k]
            stats = [reliability([r["success"] for r in rs], k) for rs in eligible]
            repeats[str(k)] = {
                "eligible_tasks": len(eligible),
                **{
                    m: sum(s[m] for s in stats) / len(stats) if stats else None
                    for m in ("pass_at_k", "pass_power_k")
                },
            }
        slices.append(
            dict(
                agent=agent,
                slice=slice_,
                planned=len(values),
                scored=len(complete),
                passed=sum(r["success"] for r in complete),
                incorrect=sum(not r["success"] for r in complete),
                errors=sum(r["status"] == "error" for r in values),
                missing=sum(r["status"] == "missing" for r in values),
                success_over_planned=sum(r["success"] for r in complete) / len(values),
                success_over_scored=sum(r["success"] for r in complete) / len(complete)
                if complete
                else None,
                input_tokens=sum(r.get("input_tokens", 0) for r in values),
                output_tokens=sum(r.get("output_tokens", 0) for r in values),
                reliability=repeats,
            )
        )
    return dict(
        schema_version=1,
        suite_version=manifest["suite_version"],
        run=manifest["run"],
        oracle=manifest["oracle"],
        complete=all(r["status"] == "scored" for r in rows),
        trials=rows,
        slices=slices,
    )


def usage_totals(usage):
    # Inspect 0.3.283 separates full-rate input from cache reads/writes.
    full = sum(u.input_tokens for u in usage)
    read = sum(u.input_tokens_cache_read or 0 for u in usage)
    write = sum(u.input_tokens_cache_write or 0 for u in usage)
    return dict(
        input_tokens=full + read + write,
        uncached_input_tokens=full,
        cached_input_tokens=read,
        cache_write_tokens=write,
        output_tokens=sum(u.output_tokens for u in usage),
    )


def read_trials(run_dir, manifest):
    observed = []
    for agent in manifest["agents"]:
        for path in sorted((run_dir / "logs" / agent["name"]).glob("*.eval")):
            log = read_eval_log(str(path))
            for sample in log.samples or []:
                result = (sample.metadata or {}).get("outcome", {})
                usage = list((sample.model_usage or {}).values())
                observed.append(
                    dict(
                        agent=agent["name"],
                        task=str(sample.id),
                        epoch=sample.epoch,
                        status="error" if sample.error or not result else "scored",
                        success=bool(result.get("success")) and not sample.error,
                        answer_correct=result.get("answer_correct"),
                        state_correct=result.get("state_correct"),
                        procedure_correct=result.get("procedure_correct"),
                        usage_reported=bool(usage),
                        failure_kind="infrastructure_or_provider"
                        if sample.error
                        else result.get("failure_kind"),
                        error=sample.error.message if sample.error else None,
                        limit=sample.limit.model_dump(mode="json")
                        if sample.limit
                        else None,
                        **usage_totals(usage),
                        seconds=sample.total_time,
                        cells=result.get("cells"),
                        sdk_calls=result.get("sdk_calls"),
                        sdk_errors=result.get("sdk_errors"),
                        cell_errors=result.get("cell_errors"),
                        truncated_outputs=result.get("truncated_outputs"),
                        log=str(path.relative_to(run_dir)),
                    )
                )
    errors = run_dir / "setup-errors.jsonl"
    if errors.exists():
        seen = {(r["agent"], r["task"], r["epoch"]) for r in observed}
        failures = {
            r["agent"]: r for r in map(json.loads, errors.read_text().splitlines())
        }
        for planned in manifest["schedule"]:
            key = planned["agent"], planned["task"], planned["epoch"]
            if key not in seen and planned["agent"] in failures:
                observed.append(
                    {
                        **planned,
                        "status": "error",
                        "success": False,
                        "failure_kind": "agent_setup",
                        "error": failures[planned["agent"]]["message"],
                    }
                )
    return observed


def write_report(run_dir):
    run_dir = Path(run_dir)
    manifest = json.loads((run_dir / "manifest.json").read_text())
    report = summarize(manifest, read_trials(run_dir, manifest))
    (run_dir / "report.json").write_text(json.dumps(report, indent=2) + "\n")
    lines = [
        f"# Relate SDK eval: {manifest['run']}",
        "",
        "Reference-solution validation; not a model benchmark."
        if manifest["oracle"]
        else "Agent means model plus solver, prompt, tools and budgets. These results measure this suite only.",
        "",
        "| Agent | Slice | Pass / planned | Scored | Errors | Missing | Input / output tokens |",
        "| --- | --- | ---: | ---: | ---: | ---: | ---: |",
    ]
    for s in report["slices"]:
        lines.append(
            f"| {s['agent']} | {s['slice']} | {s['passed']} / {s['planned']} | {s['scored']} | {s['errors']} | {s['missing']} | {s['input_tokens']} / {s['output_tokens']} |"
        )
    lines += [
        "",
        "`report.json` retains per-task results, errors, limits, SDK failures, latency and pass@k / pass^k. Reliability requires k repeated trials of the same task; data variants are not repeats. Missing/error trials stay in the planned denominator. Token usage includes retained incomplete samples; it is not a dollar bill.",
        "",
        "Browse full model/tool transcripts with `uv run inspect view --recursive --log-dir <run>/logs`. Expected answers, state comparisons and SDK calls are retained in each Inspect log.",
    ]
    (run_dir / "report.md").write_text("\n".join(lines) + "\n")
    return report


def compare(left, right):
    """Paired tasks only, with explicit unpaired/error counts."""
    a = {(r["task"], r["epoch"]): r for r in left}
    b = {(r["task"], r["epoch"]): r for r in right}
    keys = set(a) & set(b)
    pairs = [(a[k], b[k]) for k in keys if a[k]["status"] == b[k]["status"] == "scored"]
    return dict(
        paired=len(pairs),
        left_only=len(set(a) - set(b)),
        right_only=len(set(b) - set(a)),
        incomplete_pairs=len(keys) - len(pairs),
        both_pass=sum(x["success"] and y["success"] for x, y in pairs),
        left_only_pass=sum(x["success"] and not y["success"] for x, y in pairs),
        right_only_pass=sum(not x["success"] and y["success"] for x, y in pairs),
        neither_pass=sum(not x["success"] and not y["success"] for x, y in pairs),
    )
