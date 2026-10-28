"""Canonical STATE-Bench tools with agency model calls and retained usage."""
import json
import os
import uuid
from pathlib import Path
from state_bench.agents.base import BaseAgent, AgentTurnResponse, AgentToolCallRequest


def signature(text, calls):
    return json.dumps([text, [{"name": c["name"], "arguments": c["arguments"]} for c in calls]], sort_keys=True)


def messages_for(conversation, continuations):
    messages = []
    for index, turn in enumerate(conversation):
        role = turn["role"]
        if role == "tool":
            continue  # Results are already embedded in the preceding assistant.
        content = [{"type": "text", "text": turn.get("content") or ""}]
        calls = turn.get("tool_calls") or []
        for number, call in enumerate(calls):
            content.append({"type": "tool_call", "id": f"call_{index}_{number}",
                            "name": call["name"], "input": call["arguments"]})
        message = {"role": role, "content": content}
        continuation = continuations.get(signature(turn.get("content") or "", calls))
        if continuation is not None:
            message["continuation"] = continuation
        messages.append(message)
        ids = [item["call_id"] for item in continuation or [] if item.get("type") == "function_call"]
        if calls:
            results = []
            for number, call in enumerate(calls):
                if "result" not in call:
                    raise ValueError("Incomplete canonical tool result")
                results.append({"type": "tool_result", "id": ids[number] if ids else f"call_{index}_{number}",
                                "content": json.dumps(call["result"]), "isError": False})
            messages.append({"role": "user", "content": results})
    return messages


class AgencyAgent(BaseAgent):
    def __init__(self, client, system_prompt, tools, tool_handlers, runtime_context=None, agent_reasoning_effort="medium", **kwargs):
        super().__init__(runtime_context=runtime_context)
        if agent_reasoning_effort != "medium":
            raise ValueError("Agency Luna configuration requires medium reasoning")
        self.trace_id = uuid.uuid4().hex
        self.client = client
        if hasattr(client, "ensure_available"):
            client.ensure_available()
        self.continuations = {}

    def generate_next_turn(self, *, system_prompt, conversation, tools):
        # runtime_context contains grader requirements: deliberately never forward it.
        payload = {"system": system_prompt, "messages": messages_for(conversation, self.continuations),
                   "tools": [{k: t[k] for k in ("name", "description", "parameters") if k in t} for t in tools]}
        context = self.runtime_context
        if os.environ.get("AGENCY_TRACE_DIR"):
            directory = Path(os.environ["AGENCY_TRACE_DIR"])
            directory.mkdir(parents=True, exist_ok=True)
            payload["transcript"] = str(directory / f"{context.task_id if context else 'unknown'}-{self.trace_id}.jsonl")
        reply = self.client.generate(payload)
        usage = reply["usage"]
        self.add_token_usage(input_tokens=usage["inputTokens"] + usage["cacheReadTokens"] + usage["cacheWriteTokens"],
                             output_tokens=usage["outputTokens"], cached_input_tokens=usage["cacheReadTokens"])
        # Standard Luna rates <=272K input; long-context multiplier applied per call.
        long = usage["inputTokens"] + usage["cacheReadTokens"] + usage["cacheWriteTokens"] > 272000
        self.add_cost_usd(((usage["inputTokens"] * .1 + usage["cacheReadTokens"] * .01 + usage["cacheWriteTokens"] * .125) * (2 if long else 1)
                           + usage["outputTokens"] * .5 * (1.5 if long else 1)) / 1e6)
        if reply["stopReason"] != "complete":
            raise RuntimeError(f"Model stopped: {reply['stopReason']}")
        calls = []
        texts = []
        for block in reply["content"]:
            if block["type"] == "text":
                texts.append(block["text"])
            elif block["type"] == "tool_call":
                if block.get("argumentError"):
                    raise ValueError(block["argumentError"])
                calls.append(AgentToolCallRequest(name=block["name"], arguments=block["input"]))
        text = "\n".join(texts)
        self.continuations[signature(text, [{"name": c.name, "arguments": c.arguments} for c in calls])] = reply.get("continuation", [])
        return AgentTurnResponse(text=text, tool_calls=calls)
