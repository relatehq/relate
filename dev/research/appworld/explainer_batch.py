"""Resume a frozen explainer batch with bounded concurrent matched pairs.

No episode is retried. Each pair retains its frozen control/candidate order.
The single coordinator reserves budget before starting any child process.
"""

import argparse
import hashlib
import json
import subprocess
import sys
import time
from collections import deque
from pathlib import Path

from explainer_experiments import HERE, verify


def schedule(batch, ledger):
    pairs = []
    for repeat in range(ledger["repeats"]):
        for index, task in enumerate(ledger["tasks"]):
            candidates = [a for a in ledger["arms"] if a != "baseline"]
            offset = (repeat + index) % len(candidates)
            candidates = candidates[offset:] + candidates[:offset]
            for candidate in candidates:
                arms = (
                    ["baseline", candidate]
                    if (repeat + index) % 2 == 0
                    else [candidate, "baseline"]
                )
                pairs.append(
                    [
                        {
                            "candidate": candidate,
                            "arm": arm,
                            "task": task,
                            "repeat": repeat,
                            "run": f"{batch}-{candidate}-{arm}-{task}-r{repeat}",
                        }
                        for arm in arms
                    ]
                )
    return pairs


def save(path, ledger):
    temporary = path.with_suffix(".tmp")
    temporary.write_text(json.dumps(ledger, indent=2) + "\n")
    temporary.replace(path)


def execute(batch, credentials, jobs):
    folder = HERE / ".local/explainer-batches" / batch
    path = folder / "ledger.json"
    ledger = json.loads(path.read_text())
    existing = {a["run"]: a for a in ledger["attempts"]}
    if len(existing) != len(ledger["attempts"]):
        raise RuntimeError("Duplicate episode identity")
    for attempt in existing.values():
        if attempt["state"] != "finished" or attempt.get("exit") != 0:
            raise RuntimeError(
                "Resolve incomplete attempts explicitly; no automatic retry"
            )
    planned = schedule(batch, ledger)
    names = {a["run"] for pair in planned for a in pair}
    if not set(existing) <= names or len(names) != ledger["planned_episodes"]:
        raise RuntimeError("Ledger does not match frozen schedule")
    pending = deque(
        deque(a for a in pair if a["run"] not in existing)
        for pair in planned
        if any(a["run"] not in existing for a in pair)
    )
    ledger["execution"] = {
        "jobs": jobs,
        "pair_order": "unchanged; independent pairs may overlap",
        "coordinator_sha256": hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
        "reserves_budget_before_dispatch": True,
    }
    save(path, ledger)
    active = []
    failed = False
    reserved = 0.0
    while pending or active:
        while pending and len(active) < jobs and not failed:
            pair = pending.popleft()
            attempt = pair.popleft()
            root, support = verify(attempt["arm"], ledger["prepared"])
            available = ledger["maximum_usd"] - ledger["known_estimated_usd"] - reserved
            if available <= 0:
                failed = True
                break
            cap = available / (jobs - len(active))
            attempt.update(state="started", reserved_usd=cap)
            ledger["attempts"].append(attempt)
            save(path, ledger)
            output = (folder / f"{attempt['run']}.log").open("w")
            command = [
                sys.executable,
                str(support / "sdk_runner.py"),
                "--run",
                attempt["run"],
                "--tasks",
                attempt["task"],
                "--conditions",
                ledger["prepared"][attempt["arm"]]["condition"],
                "--repeats",
                "1",
                "--steps",
                "28",
                "--max-output-tokens",
                "4096",
                "--generated-budget",
                "14000",
                "--output-chars",
                "14000",
                "--max-cost-usd",
                str(cap),
                "--credentials",
                str(credentials),
            ]
            child = subprocess.Popen(
                command, cwd=root, stdout=output, stderr=subprocess.STDOUT
            )
            active.append((child, output, attempt, pair, support, cap))
            reserved += cap
        for item in active[:]:
            child, output, attempt, pair, support, cap = item
            status = child.poll()
            if status is None:
                continue
            output.close()
            summary = support / ".local/runs" / attempt["run"] / "summary.json"
            records = json.loads(summary.read_text()) if summary.exists() else []
            valid = (
                status == 0
                and len(records) == 1
                and records[0].get("error") is None
                and type(records[0].get("success")) is bool
                and records[0].get("termination") != "cost-budget"
            )
            attempt.update(
                state="finished" if valid else "incomplete",
                exit=status,
                results=records,
            )
            ledger["known_estimated_usd"] += sum(r["estimated_usd"] for r in records)
            save(path, ledger)
            reserved -= cap
            active.remove(item)
            print(
                json.dumps(
                    {
                        "run": attempt["run"],
                        "state": attempt["state"],
                        "known_estimated_usd": ledger["known_estimated_usd"],
                    }
                ),
                flush=True,
            )
            if not valid:
                failed = True
            elif pair:
                pending.appendleft(pair)
        if failed and not active:
            raise SystemExit(
                "Batch stopped; incomplete attempts retained without retry"
            )
        time.sleep(0.5)
    print("Completed frozen batch", batch, flush=True)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--batch", required=True)
    parser.add_argument("--credentials", type=Path, required=True)
    parser.add_argument("--jobs", type=int, choices=[1, 2, 3], default=3)
    args = parser.parse_args()
    execute(args.batch, args.credentials, args.jobs)
