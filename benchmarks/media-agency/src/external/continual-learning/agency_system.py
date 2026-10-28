"""Agency provider with ordered visible feedback; upstream owns task execution."""
import json
import os
from pathlib import Path
import subprocess
import uuid
from src.interface import ContinualLearningSystem, Response
from src.registry import register_system
from src.usage import UsageEvent


@register_system("agency_luna")
class AgencyLuna(ContinualLearningSystem):
    supports_baseline = True
    parallel_safe = True

    def __init__(self):
        self.reset()

    @property
    def name(self):
        return "agency_luna"

    def reset(self):
        self.messages = []
        self.trace_id = uuid.uuid4().hex

    def observe(self, observation, next_query=None):
        if observation.content:
            self.messages.append({"role": "user", "content": [{"type": "text", "text": "FEEDBACK: " + observation.content}]})

    def respond(self, query):
        root = Path(os.environ["AGENCY_ROOT"])
        self.messages.append({"role": "user", "content": [{"type": "text", "text": query.prompt or "(no content)"}]})
        payload = {
            "system": "Complete the task using its supplied interface. Call respond exactly once with your chosen action. Learn from the feedback provided between instances.",
            "messages": self.messages,
            "tools": [{"name": "respond", "description": "Submit one action to the task environment.",
                       "parameters": query.response_schema.model_json_schema()}],
            "transcript": str(Path(os.environ["AGENCY_TRACE_DIR"]) / f"{self.trace_id}.jsonl"),
        }
        command = ["node", "--env-file=.env", "--import", "tsx", str(Path(__file__).with_name("model-bridge.ts"))]
        completed = subprocess.run(command, input=json.dumps(payload) + "\n", text=True,
                                   capture_output=True, cwd=root, timeout=200, check=True)
        reply = json.loads(completed.stdout)
        if "error" in reply:
            raise RuntimeError(reply["error"])
        u = reply["usage"]
        total_input = u["inputTokens"] + u["cacheReadTokens"] + u["cacheWriteTokens"]
        long = total_input > 272000
        cost = ((u["inputTokens"] * .1 + u["cacheReadTokens"] * .01 + u["cacheWriteTokens"] * .125) * (2 if long else 1)
                + u["outputTokens"] * .5 * (1.5 if long else 1)) / 1e6
        self.record_usage_event(UsageEvent(call_type="agent", model="gpt-6-luna", provider="openai",
            input_tokens=total_input, output_tokens=u["outputTokens"], total_tokens=total_input + u["outputTokens"],
            cached_input_tokens=u["cacheReadTokens"], cache_creation_input_tokens=u["cacheWriteTokens"], cost_usd=cost,
            pricing_source="https://developers.openai.com/api/docs/models/gpt-6-luna", raw_usage=reply.get("raw", {}).get("usage")))
        if reply["stopReason"] != "complete":
            raise RuntimeError(f"Model stopped: {reply['stopReason']}")
        calls = [b for b in reply["content"] if b["type"] == "tool_call"]
        if len(calls) != 1 or calls[0]["name"] != "respond" or calls[0].get("argumentError"):
            raise ValueError("Expected exactly one valid respond action")
        action = query.response_schema.model_validate(calls[0]["input"])
        # Record chosen action as text. The environment supplies the true outcome
        # through observe(); do not fabricate a successful execution result.
        self.messages.append({"role": "assistant", "content": [{"type": "text", "text": action.model_dump_json()}]})
        return Response(action=action, metadata={"model": "gpt-6-luna", "reasoning": "medium", "trace_id": self.trace_id})

    def get_run_artifacts(self):
        return {"messages": self.messages, "trace_id": self.trace_id}
