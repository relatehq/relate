"""Bound global Docker concurrency by running domains sequentially."""
import argparse
import json
from pathlib import Path
import subprocess
import sys

if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--arm", choices=["baseline-tools", "relate"], required=True)
    parser.add_argument("--workers", type=int, default=2)
    parser.add_argument("--runs", type=int, default=1)
    args = parser.parse_args()
    output = args.output.resolve()
    output.mkdir(parents=True, exist_ok=False)
    tasks = ["customer_support", "travel", "shopping_assistant"]
    manifest = {"arm": args.arm, "split": "test", "runs": args.runs, "workers": args.workers,
                "domains": {domain: {"status": "planned"} for domain in tasks}}
    path = output / "suite.json"
    path.write_text(json.dumps(manifest, indent=2))
    for domain in tasks:
        command = [sys.executable, "-u", str(Path(__file__).with_name("run.py")),
                   "--agency-arm", args.arm, "--domain", domain, "--split", "test",
                   "--num-runs", str(args.runs), "--num-workers", str(args.workers),
                   "--output-dir", str(output / domain)]
        with (output / f"{domain}.log").open("w") as log:
            process = subprocess.Popen(command, stdout=log, stderr=subprocess.STDOUT)
            manifest["domains"][domain] = {"status": "running", "pid": process.pid, "command": command}
            path.write_text(json.dumps(manifest, indent=2))
            code = process.wait()
        manifest["domains"][domain].update(status="exited", exitCode=code)
        path.write_text(json.dumps(manifest, indent=2))
        print(domain, "exit", code, flush=True)
        log_text = (output / f"{domain}.log").read_text()
        if "credit_balance_exhausted" in log_text or "insufficient_quota" in log_text:
            manifest["status"] = "stopped-quota"
            path.write_text(json.dumps(manifest, indent=2))
            raise SystemExit("No credits remaining; unstarted domains remain planned")
