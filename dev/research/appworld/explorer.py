"""Build a local-only HTML explorer from retained AppWorld trajectories.

The template is public; generated data contains protected benchmark material and
must remain outside the repository. This does not execute model-generated code.
"""

import argparse
import json
import re
import shutil
from pathlib import Path

HERE = Path(__file__).resolve().parent
RUNS = [
    "sdk-nano-discovery-v1",
    "sdk-mini-main-v3",
    "sdk-mini-completion-feedback-v1",
    "sdk-nano-tool-pilot-v2",
]
LABELS = {
    "sdk-nano-discovery-v1": "Nano · current SDK · prompt once",
    "sdk-mini-main-v3": "Mini · previous SDK · primary",
    "sdk-mini-completion-feedback-v1": "Mini · previous SDK · per-turn reminder",
    "sdk-nano-tool-pilot-v2": "Nano · previous SDK · pilot",
}
NOTES = {
    "sdk-nano-discovery-v1": "Current rerun: four tasks × three conditions × three repeats. Current SDK operation contracts and errors; completion/answer-format instructions once in the system prompt. No per-turn reminders.",
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
                    re.I,
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
    for name in RUNS:
        base = HERE / ".local/runs" / name
        episodes = []
        for path in sorted(base.glob("*__*/result.json")):
            result = json.loads(path.read_text())
            parent = path.parent
            steps = json.loads((parent / "steps.json").read_text())
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
                        "messages": json.loads(
                            (parent / "initial_messages.json").read_text()
                        ),
                        "evaluation": json.loads(
                            (parent / "evaluation.json").read_text()
                        ),
                    }
                )
            )
        data.append(
            {
                "id": name,
                "label": LABELS[name],
                "note": NOTES[name],
                "episodes": episodes,
                "findings": findings if name == RUNS[0] else [],
                "sources": {
                    filename: (base / "source" / filename).read_text()
                    for filename in [
                        "sdk-repl.mjs", "sdk_runner.py", "sdk-graph.mjs",
                        "acquire.py", "runner.py",
                    ]
                },
            }
        )
    (destination / "data.json").write_text(json.dumps(data))
    shutil.copyfile(HERE / "explorer.html", destination / "index.html")
    for filename in ["SDK-NANO-RERUN.md", "SDK-STUDY.md"]:
        if (HERE / filename).exists():
            shutil.copyfile(HERE / filename, destination / filename)
    print(destination)
    print(f"{sum(len(run['episodes']) for run in data)} episodes")


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--findings", required=True, type=Path)
    args = parser.parse_args()
    build(args.output, json.loads(args.findings.read_text()))
