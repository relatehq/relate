"""Build a local-only HTML explorer from retained AppWorld trajectories.

The template is public; generated data contains protected benchmark material and
must remain outside the repository. This does not execute model-generated code.
"""

import argparse
import json
import re
import shutil
from pathlib import Path

from retained_usage import arm_status, episode_usage, read_json

HERE = Path(__file__).resolve().parent
RUNS = [
    "sdk-nano-queries-v1",
    "sdk-nano-contact-graph-v1",
    "sdk-nano-no-answer-v1",
    "sdk-nano-writes-28-v1",
    "sdk-nano-writes-v1",
    "sdk-nano-uniform-ts-v1",
    "sdk-nano-discovery-v1",
    "sdk-mini-main-v3",
    "sdk-mini-completion-feedback-v1",
    "sdk-nano-tool-pilot-v2",
]
LABELS = {
    "sdk-nano-queries-v1": "Nano · main queries · expanded six tasks",
    "sdk-nano-contact-graph-v1": "Nano · explicit contact graph · 28 turns",
    "sdk-nano-no-answer-v1": "Nano · explicit no-answer example · 28 turns",
    "sdk-nano-writes-28-v1": "Nano · write tasks · 28 turns",
    "sdk-nano-writes-v1": "Nano · write tasks · 14 turns",
    "sdk-nano-uniform-ts-v1": "Nano · uniform prompts · raw TS comparison",
    "sdk-nano-discovery-v1": "Nano · previous mixed SDK · prompt once",
    "sdk-mini-main-v3": "Mini · previous SDK · primary",
    "sdk-mini-completion-feedback-v1": "Mini · previous SDK · per-turn reminder",
    "sdk-nano-tool-pilot-v2": "Nano · previous SDK · pilot",
}
NOTES = {
    "sdk-nano-queries-v1": "Main query update plus improved field descriptions. Six tasks, three methods, two repeats, 28 turns. Prompts and execution protocol unchanged. Compare the original three-task subset separately; added tasks have no matched baseline in the preceding run.",
    "sdk-nano-contact-graph-v1": "Local graph experiment: explicit owner-scoped contact labels, Person.email and property descriptions. Same prompts, SDK packages, tasks, acquisition calls and 28-turn budget as the no-answer run. Fresh stochastic trajectories.",
    "sdk-nano-no-answer-v1": "Three methods, same tasks and 28-turn budget. Explicit no-answer completion example once in each system prompt. Static notes retired. Fresh stochastic runs; no SDK changes.",
    "sdk-nano-writes-28-v1": "Budget comparison: same three tasks, four methods and two repeats; 28 turns instead of 14. Exact same prompts and execution code. Fresh stochastic trajectories, not continuations of the earlier run.",
    "sdk-nano-writes-v1": "Write pilot: two training write variants + one read control × four conditions × two repeats. Main realm fix 5a0af21; two SDK actions; original evaluator; no mid-run prompt changes.",
    "sdk-nano-uniform-ts-v1": "New comparison: six tasks × four conditions × three repeats. Uniform AppWorld-inspired prompts; original APIs in Python and TypeScript; SDK-only in the same Node REPL. No per-turn reminders.",
    "sdk-nano-discovery-v1": "Previous mixed-access rerun: four tasks × three conditions × three repeats. Current SDK operation contracts and errors; completion/answer-format instructions once in the system prompt. No per-turn reminders.",
    "sdk-mini-main-v3": "Previous mini primary: two tasks × three conditions × three repeats. Earlier SDK discovery; no per-turn completion feedback. Do not pool with the current rerun.",
    "sdk-mini-completion-feedback-v1": "Previous mini follow-up: six episodes with a completion reminder after each incomplete cell, equally across conditions. Separate post-hoc experiment.",
    "sdk-nano-tool-pilot-v2": "Previous corrected nano pilot: six episodes, two tasks. Earlier SDK discovery and no explicit answer-shape instruction. All episodes reached 14 turns.",
}


def clean(value):
    if isinstance(value, dict):
        return {
            key: (
                "[redacted simulated credential]"
                if re.search(
                    r"password|access_token|refresh_token|authorization|api_key|encrypted_content",
                    key,
                    re.IGNORECASE,
                )
                else clean(item)
            )
            for key, item in value.items()
        }
    if isinstance(value, list):
        return [clean(item) for item in value]
    if isinstance(value, str):
        return re.sub(
            r"eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+",
            "[redacted simulated token]",
            value,
        )
    return value


def build(destination, findings):
    destination = destination.resolve()
    if destination.is_relative_to(HERE.parents[2]):
        raise ValueError("Generated protected data must be outside the repository")
    destination.mkdir(parents=True, exist_ok=True)
    data = []
    experiments = sorted(
        p.name
        for p in (HERE / ".local/runs").glob("sdk-nano-ergonomics-*")
        if (p / "config.json").exists()
    )
    for name in experiments:
        LABELS[name] = "Nano · independent spike · " + name.removeprefix(
            "sdk-nano-ergonomics-"
        )
        NOTES[name] = (
            "Independent SDK/graph experiment: six tasks, two repeats, unchanged prompt and 28-turn limit. Compare with the baseline in the same round; repeat indices are case labels, not shared model seeds. See ERGONOMICS.md."
        )
    for name in experiments + RUNS:
        base = HERE / ".local/runs" / name
        episodes = []
        status = (
            arm_status(base, read_json(base / "config.json", {}))
            if name in experiments
            else {}
        )
        for parent in sorted(p for p in base.glob("*__*__*") if p.is_dir()):
            task, condition, repeat = parent.name.rsplit("__", 2)
            steps = read_json(parent / "steps.json", [])
            result = read_json(
                parent / "result.json",
                {
                    "task_id": task,
                    "condition": condition,
                    "repeat": int(repeat),
                    "success": None,
                    "completed": False,
                    "termination": "in-progress",
                    "model": "",
                    "seconds": 0,
                    "steps": len(steps),
                },
            )
            result.update(episode_usage(parent))
            for step in steps:
                content = step.pop("content", "")
                try:
                    step["code"] = json.loads(content)["code"]
                except (ValueError, KeyError):
                    step["code"] = content or "No executable code"
                step["model"].pop("provider_output", None)
            episodes.append(
                clean(
                    {
                        "id": parent.name,
                        "result": result,
                        "steps": steps,
                        "api_calls": read_json(parent / "api_calls.json", []),
                        "messages": read_json(parent / "initial_messages.json", []),
                        "evaluation": read_json(parent / "evaluation.json", {}),
                    }
                )
            )
        data.append(
            {
                **status,
                "id": name,
                "label": LABELS[name],
                "note": NOTES[name]
                + (
                    f" Completed episodes: {status['completed_episodes']}/{status['expected_episodes']}. "
                    + (
                        "Eligible for comparison."
                        if status["comparison_eligible"]
                        else "Not eligible for comparison."
                    )
                    if status
                    else ""
                ),
                "episodes": episodes,
                "findings": findings if name == RUNS[0] else [],
                "sources": {
                    filename: (base / "source" / filename).read_text()
                    for filename in [
                        "sdk-repl.mjs",
                        "sdk_runner.py",
                        "sdk-graph.mjs",
                        "acquire.py",
                        "runner.py",
                        "prompts.py",
                    ]
                    if (base / "source" / filename).exists()
                },
            }
        )
    (destination / "data.json").write_text(json.dumps(data))
    shutil.copyfile(HERE / "explorer.html", destination / "index.html")
    # Export the documentation tree alongside the historical reports so their
    # current-guide links work without relying on an old checkout layout.
    for document in HERE.glob("*.md"):
        shutil.copyfile(document, destination / document.name)
    shutil.copytree(HERE / "guides", destination / "guides", dirs_exist_ok=True)
    (destination / "evidence").mkdir(exist_ok=True)
    for evidence in (HERE / "evidence").glob("*.json"):
        shutil.copyfile(evidence, destination / "evidence" / evidence.name)
    print(destination)
    print(f"{sum(len(run['episodes']) for run in data)} episodes")


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--findings", required=True, type=Path)
    args = parser.parse_args()
    build(args.output, json.loads(args.findings.read_text()))
