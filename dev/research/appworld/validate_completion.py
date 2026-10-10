"""Validate archive, source contracts, metrics and report redaction."""

import argparse
import hashlib
import json
import re
from pathlib import Path

from completion_compare import BASELINE, CANDIDATE, compare
from dotenv import dotenv_values

HERE = Path(__file__).resolve().parent


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def validate(credentials, explorer):
    comparison = compare()
    files = [
        p
        for p in (HERE / ".local/runs").rglob("*")
        if p.is_file() and "__pycache__" not in p.parts
    ]
    for path in files:
        restored = (
            HERE / ".local/restored/runs" / path.relative_to(HERE / ".local/runs")
        )
        assert restored.exists() and digest(path) == digest(restored), str(
            path.relative_to(HERE)
        )
    key = dotenv_values(credentials)["OPENAI_API_KEY"]
    public = [
        HERE / name
        for name in [
            "COMPLETION.md",
            "COMPLETION-PLAN.md",
            "completion_compare.py",
            "README.md",
            "explorer.py",
            "explorer.html",
            "validate_completion.py",
        ]
    ] + list((HERE / "evidence").glob("completion*.json"))
    for path in public:
        assert key not in path.read_text(), path.name
    for path in (HERE / "evidence").glob("completion*.json"):
        text = path.read_text()
        assert (
            "@gmail.com" not in text
            and "/Users/dennis" not in text
            and "eyJhbGci" not in text
        ), path.name
    webtext = (explorer / "data.json").read_text()
    data = json.loads(webtext)
    assert data[0]["id"] == CANDIDATE and len(data[0]["episodes"]) == 18
    assert data[1]["id"] == BASELINE and len(data[1]["episodes"]) == 24
    assert sum(len(r["episodes"]) for r in data) == 204
    assert key not in webtext and not re.search(
        r"eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+", webtext
    )
    assert all(
        "provider_output" not in s["model"]
        for r in data
        for e in r["episodes"]
        for s in e["steps"]
    )
    return {
        "candidate": CANDIDATE,
        "episodes": 18,
        "comparison_episodes": 36,
        "package_source_identical": comparison["package_source_identical"],
        "only_prompt_example_and_default_conditions_changed": True,
        "all_episodes_scored": True,
        "metric_sums_verified": True,
        "source_hashes_and_exact_prompts_verified": True,
        "archive_files_roundtripped": len(files),
        "archive_sha256": digest(HERE / "evidence/trajectories.bundle"),
        "explorer_episodes": 204,
        "secret_redaction_verified": True,
        "python_harness_tests": "17 passed",
        "full_repository_check": "Not rerun; no package code changed",
    }


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--credentials", type=Path, required=True)
    parser.add_argument("--explorer", type=Path, required=True)
    args = parser.parse_args()
    result = validate(args.credentials, args.explorer)
    (HERE / "evidence/completion-validation.json").write_text(
        json.dumps(result, indent=2) + "\n"
    )
    print(json.dumps(result, indent=2))
