"""Run upstream STATE-Bench with the agency agent. No upstream files are edited."""
import os
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
run_batch.main()
