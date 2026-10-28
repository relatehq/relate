"""Launch pinned upstream tasks with agency model calls and original scoring."""
import json
import hashlib
import os
from pathlib import Path
import shutil
import subprocess
import sys
import uuid
from dotenv import load_dotenv

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[4]
UPSTREAM = ROOT / "benchmarks/media-agency/artifacts/upstream/continual-learning"
PIN = "5f8c50eb1e84b2eda2ef4faff757dfc812a0ea26"
sys.path.insert(0, str(UPSTREAM))
load_dotenv(ROOT / ".env", override=False)
os.environ["AGENCY_ROOT"] = str(ROOT)
import agency_system  # Registers the system before upstream CLI discovery.
from src.cli import main

if __name__ == "__main__":
    arm = "agency-icl"
    image = None
    if "--agency-arm" in sys.argv:
        index = sys.argv.index("--agency-arm")
        arm = sys.argv[index + 1]
        del sys.argv[index:index + 2]
    if arm not in {"agency-icl", "relate"}:
        raise ValueError("Unknown arm")
    if arm == "relate":
        import relate_system
        image = subprocess.check_output(["docker", "image", "inspect",
            os.environ.get("AGENCY_EXECUTOR_IMAGE", "relate-agency:v2-14b8ca0"), "--format", "{{.Id}}"], text=True).strip()
        os.environ["AGENCY_EXECUTOR_IMAGE"] = image
    if subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=UPSTREAM, text=True).strip() != PIN:
        raise RuntimeError("Unexpected upstream revision")
    if "--output" not in sys.argv:
        raise ValueError("Supply --output with a fresh absolute result path")
    output = Path(sys.argv[sys.argv.index("--output") + 1]).resolve()
    output.parent.mkdir(parents=True, exist_ok=False)
    trace = output.parent / "agency-traces"
    trace.mkdir()
    os.environ["AGENCY_TRACE_DIR"] = str(trace)
    group = "agency-" + uuid.uuid4().hex
    manifest = {"benchmark": "Continual Learning Bench", "upstream": PIN,
                "arm": arm, "executorImage": image, "model": "gpt-6-luna", "reasoning": "medium",
                "runGroupId": group,
                "integrationHashes": {str(p.relative_to(HERE)): hashlib.sha256(p.read_bytes()).hexdigest()
                    for p in HERE.rglob("*") if p.is_file() and p.suffix in {".py", ".ts"}},
                "argv": sys.argv[1:], "status": "running"}
    path = output.parent / "agency-manifest.json"
    path.write_text(json.dumps(manifest, indent=2))
    os.chdir(UPSTREAM)
    sys.argv.extend(["--system", "agency_luna_relate" if arm == "relate" else "agency_luna", "--no-live-server", "--run-group-id", group])
    try:
        main()
        manifest["exitCode"] = 0
    except BaseException as error:
        manifest["exitCode"] = error.code if isinstance(error, SystemExit) else 1
        manifest["error"] = str(error)
        raise
    finally:
        # Schedule runs ignore --output. Collect only this unique run group,
        # preserving original artifacts and failed/partial traces as well.
        collected = []
        for source in (UPSTREAM / "results").rglob("*"):
            if not source.is_file() or group not in str(source.relative_to(UPSTREAM)):
                continue
            relative = source.relative_to(UPSTREAM)
            target = output.parent / "upstream-results" / relative
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(source, target)
            collected.append({"path": str(target.relative_to(output.parent)),
                              "sha256": hashlib.sha256(target.read_bytes()).hexdigest()})
        manifest["artifacts"] = collected
        manifest["status"] = "exited"
        path.write_text(json.dumps(manifest, indent=2))
