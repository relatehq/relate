"""Prepare isolated SDK arms, preflight offline, or explicitly run paid episodes.

No model calls occur without the `run` subcommand. Protected output stays local.
"""

import argparse
import hashlib
import json
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
RESEARCH = HERE.parents[2]
WORKTREES = RESEARCH.parent
BASE = "cd1a789e89208746d77b7ab85395af8e3bcf94e6"
TASKS = ["afc0fce_1", "afc0fce_2", "d0b1f43_1", "afc0fce_3", "e7a10f8_3", "82e2fac_1"]
ARMS = {
    "baseline": "explainer-sdk-experiments",
    "actions": "explainer-action-outcomes",
    "errors": "explainer-error-diagnostics",
    "collections": "explainer-collections",
    "datetime": "explainer-local-datetime",
    "relationships": "explainer-relationships",
    "filters": "explainer-traversal-filters",
    "coverage": "explainer-coverage",
    "snapshot_ts": "explainer-snapshot-control",
}


def save(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, indent=2) + "\n")


def digest(data):
    return hashlib.sha256(data).hexdigest()


def git(root, *args):
    return subprocess.check_output(["git", *args], cwd=root, text=True).strip()


def build_digest(root):
    h = hashlib.sha256()
    for path in sorted((root / "packages").glob("*/dist/**/*.js")):
        h.update(str(path.relative_to(root)).encode())
        h.update(path.read_bytes())
    return h.hexdigest()


def variant(source, arm):
    if arm == "datetime":
        assert source.count("createdAt: z.string(),") == 1, (
            "Temporal adoption patch drifted"
        )
        source = source.replace("  connect,", "  connect,\n  localDateTime,")
        source = source.replace(
            "createdAt: z.string(),",
            "createdAt: localDateTime({ precision: 'second' }),",
        )
    if arm == "coverage":
        assert "    graph,\n    actionImplementations:" in source, (
            "Coverage setup patch drifted"
        )
        assert "          });\n\n          if (result.mutationState" in source, (
            "Coverage invalidation patch drifted"
        )
        source = source.replace(
            "  let fetches = 0;",
            "  let fetches = 0;\n  let acquisitionAuthorized = true;",
        )
        source = source.replace(
            "    graph,\n    actionImplementations:",
            """    graph,
    collectionCoverage: {
      authorize: ({ actor }) => acquisitionAuthorized && actor.id === 'snapshot-reader',
      report: ({ objectDefinitionId }) => {
        const kind = Object.keys(objects).find((name) => objects[name].id === objectDefinitionId);
        return options.coverage?.[kind];
      },
    },
    actionImplementations:""",
        )
        source = source.replace(
            "const result = await writeSource({", "const result = await writeSource({"
        )
        source = source.replace(
            "          });\n\n          if (result.mutationState",
            "          }).catch((error) => { acquisitionAuthorized = false; throw error; });\n\n          if (result.mutationState",
            1,
        )
    return source


def prepare(arms):
    # New support files must be staged/committed so the set is reviewable.
    files = git(RESEARCH, "ls-files", "dev/research/appworld").splitlines()
    files = [name for name in files if Path(name).suffix in {".py", ".mjs"}]
    prepared = {}
    for arm in arms:
        root = WORKTREES / ARMS[arm]
        if git(root, "status", "--porcelain"):
            raise RuntimeError(f"Commit SDK changes before freezing {arm}")
        subprocess.run(
            [
                "pnpm",
                "exec",
                "tsc",
                "-b",
                "packages/protocol",
                "packages/relate",
                "packages/runtime",
                "packages/postgres",
                "packages/node",
                "--force",
            ],
            cwd=root,
            check=True,
        )
        support = root / "dev/research/appworld"
        support.mkdir(parents=True, exist_ok=True)
        (support / ".gitignore").write_text(
            "# Local experiment support, not SDK implementation.\n*\n"
        )
        for name in files:
            target = root / name
            target.parent.mkdir(parents=True, exist_ok=True)
            data = (RESEARCH / name).read_bytes()
            if target.name == "sdk-graph.mjs":
                data = variant(data.decode(), arm).encode()
            target.write_bytes(data)
        local = support / ".local"
        local.mkdir(exist_ok=True)
        if not (local / "world").exists():
            (local / "world").symlink_to(
                HERE / ".local/world", target_is_directory=True
            )
        subprocess.run(
            ["git", "merge-base", "--is-ancestor", BASE, "HEAD"], cwd=root, check=True
        )
        patch = subprocess.check_output(["git", "diff", BASE, "HEAD"], cwd=root)
        if arm in {"baseline", "snapshot_ts"} and patch:
            raise RuntimeError(f"Control SDK must exactly match the pinned main: {arm}")
        (local / "explainer-sdk.patch").write_bytes(patch)
        prepared[arm] = {
            "checkout": str(root),
            "branch": git(root, "branch", "--show-current"),
            "sdk_commit": git(root, "rev-parse", "HEAD"),
            "base_commit": BASE,
            "sdk_patch_sha256": digest(patch),
            "build_sha256": build_digest(root),
            "support_sha256": {
                str(Path(name).relative_to("dev/research/appworld")): digest(
                    (root / name).read_bytes()
                )
                for name in files
            },
            "condition": "snapshot_ts" if arm == "snapshot_ts" else "sdk",
        }
    save(HERE / ".local/explainer-prepared.json", prepared)
    print(
        json.dumps(
            {arm: value["sdk_commit"] for arm, value in prepared.items()}, indent=2
        )
    )


def verify(arm, prepared):
    entry = prepared[arm]
    root = Path(entry["checkout"])
    if entry.get("base_commit") != BASE:
        raise RuntimeError("Baseline changed; prepare fresh arms before running")
    if git(root, "rev-parse", "HEAD") != entry["sdk_commit"] or git(
        root, "status", "--porcelain"
    ):
        raise RuntimeError(f"SDK changed since preparation: {arm}")
    if build_digest(root) != entry["build_sha256"]:
        raise RuntimeError(f"SDK build changed: {arm}")
    support = root / "dev/research/appworld"
    for name, expected in entry["support_sha256"].items():
        if digest((support / name).read_bytes()) != expected:
            raise RuntimeError(f"Harness changed: {arm}/{name}")
    return root, support


def preflight(args, prepared):
    results = []
    for arm in args.arms:
        root, support = verify(arm, prepared)
        command = [
            sys.executable,
            str(support / "explainer_smoke.py"),
            "--arm",
            arm,
            "--tasks",
            *args.tasks,
        ]
        result = subprocess.run(
            command, cwd=root, capture_output=True, text=True, check=False
        )
        log = HERE / ".local" / f"explainer-preflight-{arm}.log"
        log.write_text(result.stdout + result.stderr)
        results.append({"arm": arm, "exit": result.returncode, "log": str(log)})
        print(json.dumps(results[-1]), flush=True)
    save(HERE / ".local/explainer-preflight.json", results)
    if any(r["exit"] for r in results):
        raise SystemExit("Offline preflight failed; inspect local logs")


def run(args, prepared):
    if not args.credentials or not args.batch:
        raise SystemExit("run requires --credentials and a unique --batch")
    if not args.batch.replace("-", "").replace("_", "").isalnum():
        raise SystemExit("batch must use letters, numbers, hyphens and underscores")
    if args.round == "holdout" and set(args.tasks) & set(TASKS):
        raise SystemExit("Holdout must exclude screening instances")
    batch = HERE / ".local/explainer-batches" / args.batch
    batch.mkdir(parents=True, exist_ok=False)
    ledger = {
        "round": args.round,
        "tasks": args.tasks,
        "repeats": args.repeats,
        "arms": args.arms,
        "planned_episodes": 2
        * args.repeats
        * len(args.tasks)
        * len([arm for arm in args.arms if arm != "baseline"]),
        "prepared": prepared,
        "attempts": [],
        "known_estimated_usd": 0.0,
        "maximum_usd": args.max_cost_usd,
    }
    save(batch / "ledger.json", ledger)
    for repeat in range(args.repeats):
        for index, task in enumerate(args.tasks):
            candidates = [arm for arm in args.arms if arm != "baseline"]
            # Rotate candidate order and alternate each paired contemporary control.
            offset = (repeat + index) % max(1, len(candidates))
            candidates = candidates[offset:] + candidates[:offset]
            for candidate in candidates:
                pair = (
                    ["baseline", candidate]
                    if (repeat + index) % 2 == 0
                    else [candidate, "baseline"]
                )
                for arm in pair:
                    root, support = verify(arm, prepared)
                    remaining = args.max_cost_usd - ledger["known_estimated_usd"]
                    if remaining <= 0:
                        raise SystemExit("Batch budget exhausted")
                    name = f"{args.batch}-{candidate}-{arm}-{task}-r{repeat}"
                    attempt = {
                        "candidate": candidate,
                        "arm": arm,
                        "task": task,
                        "repeat": repeat,
                        "run": name,
                        "state": "started",
                    }
                    ledger["attempts"].append(attempt)
                    save(batch / "ledger.json", ledger)
                    command = [
                        sys.executable,
                        str(support / "sdk_runner.py"),
                        "--run",
                        name,
                        "--tasks",
                        task,
                        "--conditions",
                        prepared[arm]["condition"],
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
                        str(remaining),
                        "--credentials",
                        str(args.credentials),
                    ]
                    with (batch / f"{name}.log").open("w") as log:
                        result = subprocess.run(
                            command,
                            cwd=root,
                            stdout=log,
                            stderr=subprocess.STDOUT,
                            check=False,
                        )
                    summary = support / ".local/runs" / name / "summary.json"
                    records = (
                        json.loads(summary.read_text()) if summary.exists() else []
                    )
                    attempt.update(
                        state="finished" if result.returncode == 0 else "incomplete",
                        exit=result.returncode,
                        results=records,
                    )
                    ledger["known_estimated_usd"] += sum(
                        r["estimated_usd"] for r in records
                    )
                    save(batch / "ledger.json", ledger)
                    print(
                        json.dumps(
                            {
                                "run": name,
                                "state": attempt["state"],
                                "known_estimated_usd": ledger["known_estimated_usd"],
                            }
                        ),
                        flush=True,
                    )
                    if result.returncode:
                        raise SystemExit(
                            "Stopped on incomplete episode; no hidden retry. Preserve ledger and provider billing uncertainty."
                        )


def check(arms):
    """Check committed SDK code without linting copied research evidence."""
    results = []
    for arm in arms:
        root = WORKTREES / ARMS[arm]
        support = root / "dev/research/appworld"
        held = (
            Path(git(root, "rev-parse", "--absolute-git-dir"))
            / "explainer-check-support"
        )
        if held.exists():
            raise RuntimeError(f"Previous held support needs restoration: {held}")
        moved = support.exists()
        log = HERE / ".local" / f"explainer-check-{arm}.log"
        if moved:
            support.rename(held)
        try:
            with log.open("w") as output:
                result = subprocess.run(
                    ["pnpm", "check"],
                    cwd=root,
                    stdout=output,
                    stderr=subprocess.STDOUT,
                    check=False,
                )
        finally:
            if moved:
                held.rename(support)
        results.append({"arm": arm, "exit": result.returncode, "log": str(log)})
        print(json.dumps(results[-1]), flush=True)
    if any(result["exit"] for result in results):
        raise SystemExit("SDK checks failed; see logs")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=["prepare", "preflight", "check", "run"])
    parser.add_argument("--arms", nargs="+", choices=list(ARMS), default=list(ARMS))
    parser.add_argument("--tasks", nargs="+", default=TASKS)
    parser.add_argument("--credentials", type=Path)
    parser.add_argument("--batch")
    parser.add_argument(
        "--round", choices=["screen", "confirm", "holdout"], default="screen"
    )
    parser.add_argument("--repeats", type=int, default=2)
    parser.add_argument("--max-cost-usd", type=float, default=5)
    args = parser.parse_args()
    if args.repeats < 1 or not 0 < args.max_cost_usd <= 5:
        parser.error("positive repeats and a batch cap in (0, 5] are required")
    if args.command == "run" and not any(arm != "baseline" for arm in args.arms):
        parser.error("run requires a candidate arm; its paired baseline is automatic")
    if args.command == "check":
        check(args.arms)
    elif args.command == "prepare":
        prepare(args.arms)
    else:
        prepared = json.loads((HERE / ".local/explainer-prepared.json").read_text())
        if args.command == "preflight":
            preflight(args, prepared)
        else:
            run(args, prepared)


if __name__ == "__main__":
    main()
