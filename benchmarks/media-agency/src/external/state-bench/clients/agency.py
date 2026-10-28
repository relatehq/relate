"""Use the agency benchmark's OpenAI provider; credentials stay in the host."""
import json
import os
from pathlib import Path
import subprocess
import threading
from state_bench.client import BaseLLMClient


class AgencyClient(BaseLLMClient):
    quota_error = None
    quota_lock = threading.Lock()

    def ensure_available(self):
        if type(self).quota_error:
            raise RuntimeError(type(self).quota_error)

    @property
    def model_name(self):
        return "gpt-6-luna"

    def generate(self, payload):
        self.ensure_available()
        root = Path(os.environ["AGENCY_ROOT"]).resolve()
        bridge = root / "benchmarks/media-agency/src/external/state-bench/model-bridge.ts"
        result = subprocess.run(
            ["node", "--env-file=.env", "--import", "tsx", str(bridge)],
            input=json.dumps(payload) + "\n", text=True, capture_output=True,
            cwd=root, timeout=200, check=True,
        )
        reply = json.loads(result.stdout)
        if "error" in reply:
            error = reply["error"]
            if "credit_balance_exhausted" in error or "insufficient_quota" in error:
                with type(self).quota_lock:
                    type(self).quota_error = error
            if os.environ.get("AGENCY_TRACE_DIR"):
                path = Path(os.environ["AGENCY_TRACE_DIR"]).parent / "agency-errors.jsonl"
                with path.open("a") as log:
                    log.write(json.dumps({"trace": payload.get("transcript"), "error": error}) + "\n")
            raise RuntimeError(reply["error"])
        return reply
