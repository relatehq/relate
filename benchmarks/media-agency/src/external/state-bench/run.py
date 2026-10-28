"""Run upstream STATE-Bench with the agency agent. No upstream files are edited."""
import os
import json
import hashlib
import subprocess
from pathlib import Path
import sys
from dotenv import load_dotenv

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[4]
load_dotenv(ROOT / ".env", override=False)
os.environ["AGENCY_ROOT"] = str(ROOT)
# Extension discovery is cwd-based; data paths remain in the pinned upstream package.
os.chdir(HERE)
from state_bench.client import build_llm_client
from state_bench.scripts import run_batch

# Upstream currently hardcodes Azure transport for evaluation. Preserve its
# locked model/prompts/grading while using our available OpenAI API account.
def evaluation_client():
    return build_llm_client(provider="openai", deployments=["gpt-5.4"], api_key_var="OPENAI_API_KEY")

run_batch.build_user_sim_client = evaluation_client
run_batch.build_locked_judge_client = evaluation_client
sys.argv.extend(["--agent-class", "AgencyAgent", "--agent-client-class", "AgencyClient",
                 "--agent-model-name", "gpt-6-luna", "--agent-model-reasoning-level", "medium"])
# Freeze selection and source hashes before any paid requests. A new directory is
# required so retries cannot replace failed attempts in an earlier denominator.
def option(name, default=None):
    return sys.argv[sys.argv.index(name) + 1] if name in sys.argv else default

from state_bench.paths import PACKAGE_ROOT
from state_bench.protocol import load_split_task_ids
output = Path(option("--output-dir")).resolve()
output.mkdir(parents=True, exist_ok=False)
os.environ["AGENCY_TRACE_DIR"] = str(output / "agency-traces")
domain = option("--domain")
selection = option("--tasks")
task_ids = selection.split(",") if selection else load_split_task_ids(domain, option("--split", "all"), "train_test")
manifest = {
    "benchmark": "STATE-Bench", "arm": "baseline-tools", "domain": domain,
    "model": "gpt-6-luna", "reasoning": "medium", "maxOutputTokens": 8192,
    "evaluationModel": "gpt-5.4", "evaluationTransport": "openai",
    "tasks": task_ids, "runs": int(option("--num-runs", "1")),
    "upstreamRevision": subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=PACKAGE_ROOT, text=True).strip(),
    "relateRevision": subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=ROOT, text=True).strip(),
    "integrationHashes": {str(p.relative_to(HERE)): hashlib.sha256(p.read_bytes()).hexdigest()
                           for p in HERE.rglob("*") if p.is_file() and p.suffix in {".py", ".ts"}},
    "argv": sys.argv[1:], "status": "running",
}
(output / "manifest.json").write_text(json.dumps(manifest, indent=2))
if "--retry-attempts" not in sys.argv:
    sys.argv.extend(["--retry-attempts", "1"])
try:
    run_batch.main()
finally:
    manifest["status"] = "exited"
    (output / "manifest.json").write_text(json.dumps(manifest, indent=2))

