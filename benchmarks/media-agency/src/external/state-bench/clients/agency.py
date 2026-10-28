"""Use the agency benchmark's OpenAI provider; credentials stay in the host."""
import json
import os
from pathlib import Path
import subprocess
from state_bench.client import BaseLLMClient


class AgencyClient(BaseLLMClient):
    @property
    def model_name(self):
        return "gpt-6-luna"

    def generate(self, payload):
        root = Path(os.environ["AGENCY_ROOT"]).resolve()
        bridge = root / "benchmarks/media-agency/src/external/state-bench/model-bridge.ts"
        result = subprocess.run(
            ["node", "--env-file=.env", "--import", "tsx", str(bridge)],
            input=json.dumps(payload) + "\n", text=True, capture_output=True,
            cwd=root, timeout=200, check=True,
        )
        reply = json.loads(result.stdout)
        if "error" in reply:
            raise RuntimeError(reply["error"])
        return reply
