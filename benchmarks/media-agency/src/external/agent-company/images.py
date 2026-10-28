"""Freeze public task image digests before model calls or service mutations."""
import argparse
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
import json
from pathlib import Path
import subprocess
import threading

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[4]
UPSTREAM = ROOT / "benchmarks/media-agency/artifacts/upstream/agent-company"
PIN = "98b68ef82a47690c316f42fddb05baafaab56851"


def select_digest(manifest):
    entries = manifest if isinstance(manifest, list) else [manifest]
    matches = [row["Descriptor"]["digest"] for row in entries
               if row.get("Descriptor", {}).get("platform", {}) == {"architecture": "amd64", "os": "linux"}]
    if len(matches) != 1 or not matches[0].startswith("sha256:"):
        raise ValueError("Expected exactly one linux/amd64 image descriptor")
    return matches[0]


def freeze(tasks, output, workers=4):
    output = Path(output)
    if output.exists():
        raise FileExistsError("Image lock must be a new file")
    if subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=UPSTREAM, text=True).strip() != PIN:
        raise RuntimeError("Unexpected upstream revision")
    output.parent.mkdir(parents=True, exist_ok=True)
    manifest = {"upstream": PIN, "createdAt": datetime.now(timezone.utc).isoformat(), "platform": "linux/amd64",
                "images": {task: {"status": "planned"} for task in tasks}, "status": "resolving"}
    lock = threading.Lock()
    def save():
        temporary = output.with_suffix(".tmp")
        temporary.write_text(json.dumps(manifest, indent=2))
        temporary.replace(output)
    save()
    def resolve(task):
        tag = f"ghcr.io/theagentcompany/{task}-image:1.0.0"
        try:
            result = subprocess.run(["docker", "manifest", "inspect", "--verbose", tag],
                                    capture_output=True, text=True, timeout=90)
            if result.returncode:
                raise RuntimeError(result.stderr.strip())
            descriptor = json.loads(result.stdout)
            digest = select_digest(descriptor)
            row = {"status": "resolved", "tag": tag, "digest": digest,
                   "reference": tag.rsplit(":", 1)[0] + "@" + digest, "descriptor": descriptor}
        except Exception as error:
            row = {"status": "error", "tag": tag, "error": str(error)}
        with lock:
            manifest["images"][task] = row
            save()
        return row["status"] == "resolved"
    with ThreadPoolExecutor(max_workers=workers) as pool:
        resolved = list(pool.map(resolve, tasks))
    manifest["status"] = "ready" if all(resolved) else "incomplete"
    save()
    return manifest


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    tasks = sorted(p.name for p in (UPSTREAM / "workspaces/tasks").iterdir() if (p / "task.md").exists())
    result = freeze(tasks, args.output)
    successes = sum(row["status"] == "resolved" for row in result["images"].values())
    print(f"Resolved {successes}/{len(tasks)} original task images: {result['status']}")
    raise SystemExit(0 if result["status"] == "ready" else 1)
