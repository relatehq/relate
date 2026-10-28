"""Run every default task schedule, retaining failed tasks in the suite manifest."""
import argparse
from concurrent.futures import ThreadPoolExecutor
import json
from pathlib import Path
import subprocess
import sys
import threading

TASKS = ["exploitable_poker", "database_exploration", "cohort_studies",
         "sales_prediction", "blind_spectrum_monitoring", "codebase_adaptation"]

if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--workers", type=int, default=2)
    parser.add_argument("--runs", type=int, default=1)
    parser.add_argument("--agency-arm", choices=["agency-icl", "relate"], default="agency-icl")
    args = parser.parse_args()
    output = args.output.resolve()
    output.mkdir(parents=True, exist_ok=False)
    manifest = {"model": "gpt-6-luna", "reasoning": "medium", "schedule": "default",
                "arm": args.agency_arm, "runsPerTask": args.runs, "tasks": {task: {"status": "planned"} for task in TASKS}}
    path = output / "suite.json"
    lock = threading.Lock()
    quota_stop = threading.Event()
    def save(task, **changes):
        with lock:
            manifest["tasks"][task].update(changes)
            temporary = path.with_suffix(".tmp")
            temporary.write_text(json.dumps(manifest, indent=2))
            temporary.replace(path)
    path.write_text(json.dumps(manifest, indent=2))
    def run(task):
        if quota_stop.is_set():
            save(task, status="not-started-quota")
            return 1
        command = [sys.executable, "-u", str(Path(__file__).with_name("run.py")),
                   "run", task, "--schedule", "default", "--runs", str(args.runs),
                   "--max-workers", "2", "--agency-arm", args.agency_arm, "--output", str(output / task / "result.json")]
        with (output / f"{task}.log").open("w") as log:
            process = subprocess.Popen(command, stdout=log, stderr=subprocess.STDOUT)
            save(task, status="running", pid=process.pid, command=command)
            code = process.wait()
        save(task, status="exited", exitCode=code)
        log_text = (output / f"{task}.log").read_text()
        if "credit_balance_exhausted" in log_text or "insufficient_quota" in log_text:
            quota_stop.set()
        print(f"{task}: exit {code}", flush=True)
        return code
    with ThreadPoolExecutor(max_workers=args.workers) as pool:
        codes = list(pool.map(run, TASKS))
    sys.exit(1 if any(codes) else 0)
