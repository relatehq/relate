"""Small workflow commands; Inspect owns model execution and logs."""

import argparse
import hashlib
import importlib.metadata
import inspect
import json
import shutil
import subprocess
import uuid
from datetime import datetime, timezone
from pathlib import Path

from .catalog import VERSION, cases, select
from .report import compare, write_report
from .session import PREPARED, ROOT


def sha(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def run_command(args):
    from inspect_ai import eval

    from .task import sdk_tasks

    config = json.loads(Path(args.config).read_text()) if args.config else {}
    agents = (
        [{"name": "oracle", "model": "mockllm/model"}]
        if args.oracle
        else config.get("agents", [])
    )
    if not agents:
        raise ValueError("Provide --config with at least one {name, model} agent")
    names = [a["name"] for a in agents]
    if len(set(names)) != len(names) or any(
        not n
        or any(
            c not in "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_"
            for c in n
        )
        for n in names
    ):
        raise ValueError("Agent names must be unique alphanumeric slugs")
    epochs = args.epochs if args.epochs is not None else config.get("epochs", 1)
    if not isinstance(epochs, int) or epochs < 1:
        raise ValueError("epochs must be a positive integer")
    selection = config.get("selection", {})
    families = (
        args.families.split(",") if args.families else selection.get("families", [])
    )
    seeds = (
        [int(n) for n in args.seeds.split(",")]
        if args.seeds
        else selection.get("seeds", [11, 29, 47])
    )
    levels = selection.get("levels", [])
    selected = select(families=families, levels=levels, seeds=seeds)
    limits = {
        "max_cells": 24,
        "max_operations": 400,
        "cell_timeout": 20,
        **config.get("limits", {}),
    }
    if set(limits) != {"max_cells", "max_operations", "cell_timeout"} or any(
        not isinstance(v, int) or v < 1 for v in limits.values()
    ):
        raise ValueError(
            "limits must contain positive max_cells, max_operations, cell_timeout"
        )
    image_tag = config.get("image", "relate-agent-eval:local")
    image = subprocess.check_output(
        ["docker", "image", "inspect", image_tag, "--format", "{{.Id}}"], text=True
    ).strip()
    # Docker Desktop may reclaim an untagged manifest when the moving local
    # tag is rebuilt. Keep a dedicated tag as well as the immutable image ID.
    retained_tag = "relate-agent-eval:run-" + uuid.uuid4().hex
    subprocess.run(["docker", "tag", image, retained_tag], check=True)
    prepared = json.loads((PREPARED / "manifest.json").read_text())
    for name in ("worker", "world"):
        if sha(PREPARED / f"{name}.mjs") != prepared[f"{name}Sha256"]:
            raise ValueError("Prepared SDK bundle changed; prepare again")
    image_hash = subprocess.check_output(
        [
            "docker",
            "run",
            "--rm",
            "--network=none",
            "--entrypoint",
            "sha256sum",
            image,
            "/app/worker.mjs",
        ],
        text=True,
    ).split()[0]
    if image_hash != prepared["workerSha256"]:
        raise ValueError("Docker image and prepared SDK differ; rebuild the image")
    run_dir = Path(args.output).resolve()
    run_dir.mkdir(parents=True, exist_ok=False)
    sources = run_dir / "sources"
    sources.mkdir()
    source_hashes = {}
    for folder in ("relate_eval", "environment"):
        for path in sorted((ROOT / folder).glob("*")):
            if path.is_file():
                dest = sources / folder / path.name
                dest.parent.mkdir(exist_ok=True)
                shutil.copyfile(path, dest)
                source_hashes[str(dest.relative_to(sources))] = sha(dest)
    for name in ("uv.lock", "pyproject.toml", "package-lock.json", "package.json"):
        shutil.copyfile(ROOT / name, sources / name)
        source_hashes[name] = sha(sources / name)
    agent_sources = {}
    for agent in agents:
        spec = agent.get("solver", "tool-agent")
        if spec != "tool-agent":
            module = importlib.import_module(spec.split(":", 1)[0])
            path = Path(inspect.getfile(module))
            dest = sources / "agents" / (agent["name"] + path.suffix)
            dest.parent.mkdir(exist_ok=True)
            shutil.copyfile(path, dest)
            key = str(dest.relative_to(sources))
            source_hashes[key] = sha(dest)
            agent_sources[spec] = key
    shutil.copytree(PREPARED, sources / "prepared")
    for name in ("worker", "world"):
        if sha(sources / "prepared" / f"{name}.mjs") != prepared[f"{name}Sha256"]:
            raise ValueError("SDK preparation changed during snapshot; start a new run")
    manifest = dict(
        schema_version=1,
        suite_version=VERSION,
        run=run_dir.name,
        created_at=datetime.now(timezone.utc).isoformat(),
        oracle=args.oracle,
        agents=agents,
        limits=limits,
        epochs=epochs,
        image=image,
        retained_image_tag=retained_tag,
        prepared=prepared,
        source_hashes=source_hashes,
        agent_sources=agent_sources,
        concurrency=config.get("concurrency", 2),
        packages={
            d.metadata["Name"]: d.version for d in importlib.metadata.distributions()
        },
        inspect_version=importlib.metadata.version("inspect-ai"),
        schedule=[
            dict(agent=a["name"], task=c.id, family=c.family, level=c.level, epoch=e)
            for a in agents
            for c in selected
            for e in range(1, epochs + 1)
        ],
    )
    (run_dir / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
    (run_dir / "tasks.json").write_text(
        json.dumps([c.public() for c in selected], indent=2) + "\n"
    )
    print(f"Scheduled {len(manifest['schedule'])} trials in {run_dir}", flush=True)
    # Frozen prepared files are used for the entire run, even if another checkout
    # prepares a new SDK while this evaluation is active.
    from . import session

    session.PREPARED = sources / "prepared"
    try:
        for agent in agents:
            task = sdk_tasks(
                families=",".join(families),
                levels=",".join(map(str, levels)),
                seeds=",".join(map(str, seeds)),
                agent=agent.get("solver", "tool-agent"),
                image=image,
                oracle=args.oracle,
                **limits,
            )
            try:
                eval(
                    task,
                    model=agent["model"],
                    model_args=agent.get("model_args", {}),
                    epochs=epochs,
                    log_dir=str(run_dir / "logs" / agent["name"]),
                    max_samples=config.get("concurrency", 2),
                    display="plain",
                    retry_on_error=0,
                    log_model_api=True,
                    **agent.get("generate_config", {}),
                )
            except (Exception, SystemExit) as exc:
                errors = run_dir / "setup-errors.jsonl"
                with errors.open("a") as f:
                    f.write(
                        json.dumps(
                            {
                                "agent": agent["name"],
                                "type": type(exc).__name__,
                                "message": str(exc),
                            }
                        )
                        + "\n"
                    )
                print(
                    f"Agent {agent['name']} failed to start; retained setup-errors.jsonl",
                    flush=True,
                )
    finally:
        report = write_report(run_dir)
        print(f"Report: {run_dir / 'report.md'}", flush=True)
    if not report["complete"]:
        return 2
    if args.oracle and any(not r["success"] for r in report["trials"]):
        return 1
    return 0


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)
    listing = sub.add_parser("list", help="List public task inventory")
    listing.add_argument("--json", action="store_true")
    run = sub.add_parser("run", help="Run a fresh model matrix or reference validation")
    run.add_argument("--config")
    run.add_argument("--oracle", action="store_true")
    run.add_argument("--output", required=True)
    run.add_argument("--families")
    run.add_argument("--seeds")
    run.add_argument("--epochs", type=int)
    report = sub.add_parser("report", help="Rebuild reports from retained Inspect logs")
    report.add_argument("run")
    comparison = sub.add_parser("compare", help="Paired comparison within a run")
    comparison.add_argument("run")
    comparison.add_argument("left")
    comparison.add_argument("right")
    args = parser.parse_args()
    if args.command == "list":
        if args.json:
            print(json.dumps([c.public() for c in cases()], indent=2))
        else:
            for c in cases((11,)):
                print(f"L{c.level} {c.family:25} {c.prompt}")
            print(
                f"\n{len(cases())} tasks; {len(cases((11,)))} families; 3 data variants each"
            )
    elif args.command == "run":
        raise SystemExit(run_command(args))
    elif args.command == "report":
        write_report(args.run)
    else:
        report = write_report(args.run)
        names = {r["agent"] for r in report["trials"]}
        if args.left not in names or args.right not in names:
            parser.error("Both agents must occur in the run")
        print(
            json.dumps(
                compare(
                    [r for r in report["trials"] if r["agent"] == args.left],
                    [r for r in report["trials"] if r["agent"] == args.right],
                ),
                indent=2,
            )
        )


if __name__ == "__main__":
    main()
