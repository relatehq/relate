"""Launch pinned upstream tasks with agency model calls and original scoring."""
import json
import os
from pathlib import Path
import subprocess
import sys
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
    if subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=UPSTREAM, text=True).strip() != PIN:
        raise RuntimeError("Unexpected upstream revision")
    if "--output" not in sys.argv:
        raise ValueError("Supply --output with a fresh absolute result path")
    output = Path(sys.argv[sys.argv.index("--output") + 1]).resolve()
    output.parent.mkdir(parents=True, exist_ok=False)
    trace = output.parent / "agency-traces"
    trace.mkdir()
    os.environ["AGENCY_TRACE_DIR"] = str(trace)
    manifest = {"benchmark": "Continual Learning Bench", "upstream": PIN,
                "arm": "agency-icl", "model": "gpt-6-luna", "reasoning": "medium",
                "argv": sys.argv[1:], "status": "running"}
    path = output.parent / "agency-manifest.json"
    path.write_text(json.dumps(manifest, indent=2))
    os.chdir(UPSTREAM)
    sys.argv.extend(["--system", "agency_luna", "--no-live-server"])
    try:
        main()
    finally:
        manifest["status"] = "exited"
        path.write_text(json.dumps(manifest, indent=2))
