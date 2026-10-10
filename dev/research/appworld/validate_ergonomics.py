"""Audit retained experiment evidence, archive restoration and local explorer."""

import argparse
import difflib
import hashlib
import json
import re
from pathlib import Path

from dotenv import dotenv_values
from ergonomics_compare import HERE, PREFIX, analyze


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def validate(credentials, explorer):
    computed = analyze()
    assert computed == json.loads((HERE / "evidence/ergonomics.json").read_text())
    assert computed["estimated_usd"] <= 2
    assert len(computed["runs"]) >= 6
    assert all(
        not run["package_diff"]
        for name, run in computed["runs"].items()
        if any(arm in name for arm in ["-baseline-", "-contacts-", "-dates-"])
    )
    baseline_graph = (
        (HERE / ".local/runs" / (PREFIX + "baseline-v1") / "source/sdk-graph.mjs")
        .read_text()
        .splitlines(keepends=True)
    )
    for name in computed["runs"]:
        for arm, filename in [("contacts", "contact"), ("dates", "date")]:
            if f"-{arm}-" not in name:
                continue
            candidate_graph = (
                (HERE / ".local/runs" / name / "source/sdk-graph.mjs")
                .read_text()
                .splitlines(keepends=True)
            )
            actual_patch = "".join(
                difflib.unified_diff(
                    baseline_graph,
                    candidate_graph,
                    fromfile="a/dev/research/appworld/sdk-graph.mjs",
                    tofile="b/dev/research/appworld/sdk-graph.mjs",
                )
            )
            assert (
                actual_patch
                == (
                    HERE / "evidence" / f"graph-{filename}-description.patch"
                ).read_text()
            )
    count = 0
    for path in (HERE / ".local/runs").rglob("*"):
        if not path.is_file() or "__pycache__" in path.parts:
            continue
        restored = (
            HERE / ".local/restored/runs" / path.relative_to(HERE / ".local/runs")
        )
        assert restored.exists() and digest(path) == digest(restored), str(path)
        count += 1
    key = dotenv_values(credentials)["OPENAI_API_KEY"]
    public = [
        HERE / name
        for name in [
            "ERGONOMICS.md",
            "ERGONOMICS-PLAN.md",
            "ergonomics_compare.py",
            "validate_ergonomics.py",
            "README.md",
            "explorer.py",
            "explorer.html",
            "evidence/ergonomics.json",
        ]
    ]
    for path in public:
        assert key not in path.read_text(), path.name
    evidence = (HERE / "evidence/ergonomics.json").read_text()
    assert not any(
        value in evidence for value in ["@gmail.com", "/Users/dennis", "eyJhbGci"]
    )
    text = (explorer / "data.json").read_text()
    assert key not in text
    assert not re.search(r"eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+", text)
    runs = json.loads(text)
    experiments = {run["id"]: run for run in runs if run["id"].startswith(PREFIX)}
    assert set(experiments) == set(computed["runs"])
    for name, run in experiments.items():
        assert len(run["episodes"]) == 12
        assert (
            sum(e["result"]["success"] for e in run["episodes"])
            == computed["runs"][name]["metrics"]["success"]
        )
        assert all(
            "provider_output" not in step["model"]
            for e in run["episodes"]
            for step in e["steps"]
        )
    assert sum(len(run["episodes"]) for run in runs) == 258 + 12 * len(experiments)
    print(
        f"Validated {len(experiments)} experiment arms, {count} restored files, accounting, frozen sources and redaction."
    )


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--credentials", required=True, type=Path)
    parser.add_argument("--explorer", required=True, type=Path)
    args = parser.parse_args()
    validate(args.credentials, args.explorer)
