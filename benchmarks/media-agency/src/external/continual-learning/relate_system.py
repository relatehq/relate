"""Submit typed task actions via Relate; the upstream engine executes them."""
import json
import os
from pathlib import Path
import subprocess
import uuid
from src.interface import ContinualLearningSystem, Response
from src.registry import register_system
from src.usage import UsageEvent
from executor import RelateBridge


@register_system("agency_luna_relate")
class AgencyLunaRelate(ContinualLearningSystem):
    supports_baseline = True
    parallel_safe = True

    def __init__(self):
        self.reset()

    @property
    def name(self):
        return "agency_luna_relate"

    def reset(self):
        self.messages = []
        self.trace_id = uuid.uuid4().hex

    def observe(self, observation, next_query=None):
        if observation.content:
            self.messages.append({"role": "user", "content": [{"type": "text", "text": "FEEDBACK: " + observation.content}]})

    def complete(self, tools, instructions, remaining_tokens):
        root = Path(os.environ["AGENCY_ROOT"])
        payload = {
            "system": "Complete the task using its supplied interface. Learn from feedback between instances. "
                      "Discover and call the Relate respond action exactly once to submit your choice. "
                      "A successful receipt means the choice was accepted for later execution by the task engine; "
                      "it does not mean the task succeeded. "
                      'Invoke with graph.actions.respond({input:{arguments:JSON.stringify(action)},idempotencyKey:"unique-choice"}); '
                      "where action is the object matching the original task schema. " + instructions,
            "messages": self.messages, "tools": tools,
            "maxOutputTokens": remaining_tokens,
            "transcript": str(Path(os.environ["AGENCY_TRACE_DIR"]) / f"{self.trace_id}.jsonl"),
        }
        completed = subprocess.run(["node", "--env-file=.env", "--import", "tsx", str(Path(__file__).with_name("relate-model-bridge.ts"))],
            input=json.dumps(payload) + "\n", text=True, capture_output=True, cwd=root, timeout=200, check=True)
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
        return reply

    def respond(self, query):
        self.messages.append({"role": "user", "content": [{"type": "text", "text": query.prompt or "(no content)"}]})
        history_boundary = len(self.messages)
        selected = []
        def submit(args):
            if selected:
                raise ValueError("Only one task action can be submitted per query")
            selected.append(query.response_schema.model_validate(args))
            return {"accepted": True, "execution": "pending task engine"}
        bridge = RelateBridge([{"name": "respond", "description": "Submit one action to the task engine.",
                               "parameters": query.response_schema.model_json_schema()}], {"respond": submit})
        tools = [
            {"name": "discover", "description": "Discover the task action and its input schema.",
             "parameters": {"type": "object", "properties": {}, "additionalProperties": False}},
            {"name": "execute", "description": bridge.instructions,
             "parameters": {"type": "object", "properties": {"code": {"type": "string"}},
                            "required": ["code"], "additionalProperties": False}},
        ]
        try:
            remaining_tokens = 8192
            for _ in range(8):
                if remaining_tokens <= 0:
                    raise RuntimeError("Per-query output token budget exhausted")
                reply = self.complete(tools, bridge.instructions, remaining_tokens)
                remaining_tokens -= reply["usage"]["outputTokens"]
                message = {"role": "assistant", "content": reply["content"]}
                if reply.get("continuation"):
                    message["continuation"] = reply["continuation"]
                self.messages.append(message)
                results = []
                for call in [b for b in reply["content"] if b["type"] == "tool_call"]:
                    if call.get("argumentError"):
                        raise ValueError(call["argumentError"])
                    if call["name"] == "discover":
                        value = bridge.call({"type": "discover"})
                    elif call["name"] == "execute":
                        value = bridge.call({"type": "execute", "code": call["input"]["code"]})
                    else:
                        raise ValueError("Unknown interface tool: " + call["name"])
                    results.append({"type": "tool_result", "id": call["id"], "content": json.dumps(value), "isError": False})
                if results:
                    self.messages.append({"role": "user", "content": results})
                if selected:
                    # Match the direct adapter's across-query memory: public
                    # prompt, typed choice, then true engine feedback. Detailed
                    # interface/continuation traces remain in agency-traces.
                    self.messages[history_boundary:] = [{"role": "assistant", "content": [
                        {"type": "text", "text": selected[0].model_dump_json()}]}]
                    return Response(action=selected[0], metadata={"model": "gpt-6-luna", "reasoning": "medium", "trace_id": self.trace_id})
                if not results:
                    raise ValueError("Model ended without submitting a typed action")
            raise RuntimeError("Relate did not submit an action within eight rounds")
        finally:
            bridge.close()

    def get_run_artifacts(self):
        return {"messages": self.messages, "trace_id": self.trace_id}
