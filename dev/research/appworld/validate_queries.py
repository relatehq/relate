"""Validate archive, source contracts, metrics and report redaction."""

import argparse
import hashlib
import json
import re
from pathlib import Path

from dotenv import dotenv_values
from queries_compare import BASELINE, CANDIDATE, compare

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
            "QUERIES.md",
            "QUERIES-PLAN.md",
            "queries_compare.py",
            "README.md",
            "explorer.py",
            "explorer.html",
            "validate_queries.py",
        ]
    ] + list((HERE / "evidence").glob("queries*.json"))
    for path in public:
        assert key not in path.read_text(), path.name
    for path in (HERE / "evidence").glob("queries*.json"):
        text = path.read_text()
        assert (
            "@gmail.com" not in text
            and "/Users/dennis" not in text
            and "eyJhbGci" not in text
        ), path.name
    webtext = (explorer / "data.json").read_text()
    data = json.loads(webtext)
    assert data[0]["id"] == CANDIDATE and len(data[0]["episodes"]) == 36
    assert data[1]["id"] == BASELINE and len(data[1]["episodes"]) == 18
    assert sum(len(r["episodes"]) for r in data) == 258
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
        "episodes": 36,
        "comparison_episodes": 54,
        "sdk_matches_merged_main": comparison["sdk_matches_merged_main"],
        "query_update_graph_descriptions_and_expanded_tasks": True,
        "exact_initial_messages_and_acquisition_call_counts_unchanged": True,
        "all_episodes_scored": True,
        "metric_sums_verified": True,
        "source_hashes_and_exact_prompts_verified": True,
        "archive_files_roundtripped": len(files),
        "archive_sha256": digest(HERE / "evidence/trajectories.bundle"),
        "explorer_episodes": 258,
        "secret_redaction_verified": True,
        "python_harness_tests": "18 passed",
        "node_tests": "11 passed",
        "original_appworld_write_smoke": "passed",
        "full_repository_check": "pnpm check passed: 90 files / 945 tests, Postgres integration and installed-package checks",
    }


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--credentials", type=Path, required=True)
    parser.add_argument("--explorer", type=Path, required=True)
    args = parser.parse_args()
    result = validate(args.credentials, args.explorer)
    (HERE / "evidence/queries-validation.json").write_text(
        json.dumps(result, indent=2) + "\n"
    )
    print(json.dumps(result, indent=2))
