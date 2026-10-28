import importlib.util
import json
import os
from pathlib import Path
import sys
from types import SimpleNamespace
from pydantic import BaseModel

HERE = Path(__file__).resolve().parents[1]
ROOT = HERE.parents[4]
sys.path.insert(0, str(ROOT / "benchmarks/media-agency/artifacts/upstream/continual-learning"))
spec = importlib.util.spec_from_file_location("agency_system_test", HERE / "agency_system.py")
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class Action(BaseModel):
    choice: str


def test_visible_feedback_is_kept_until_reset(monkeypatch, tmp_path):
    monkeypatch.setenv("AGENCY_ROOT", str(ROOT))
    monkeypatch.setenv("AGENCY_TRACE_DIR", str(tmp_path))
    seen = []
    def execute(command, **kwargs):
        seen.append(json.loads(kwargs["input"]))
        return SimpleNamespace(stdout=json.dumps({"usage": {"inputTokens": 10, "outputTokens": 5,
            "cacheReadTokens": 0, "cacheWriteTokens": 0}, "stopReason": "complete",
            "content": [{"type": "tool_call", "id": "c1", "name": "respond", "input": {"choice": "A"}}]}))
    monkeypatch.setattr(module.subprocess, "run", execute)
    system = module.AgencyLuna()
    system.observe(SimpleNamespace(content="visible feedback"))
    response = system.respond(SimpleNamespace(prompt="choose", response_schema=Action, hidden_answer="DO NOT SEND"))
    assert response.action.choice == "A"
    assert "visible feedback" in json.dumps(seen)
    assert "DO NOT SEND" not in json.dumps(seen)
    assert system.consume_usage_events()[0].total_tokens == 15
    system.reset()
    assert system.messages == []


def test_plain_json_action_validated_and_ambiguous_calls_rejected():
    import pytest
    assert module.parse_action({"content": [{"type": "text", "text": '{"choice":"B"}'}]}, Action).choice == "B"
    with pytest.raises(ValueError):
        module.parse_action({"content": [{"type": "text", "text": 'not JSON'}]}, Action)
    with pytest.raises(ValueError):
        module.parse_action({"content": [{"type": "tool_call", "name": "respond", "input": {"choice": "A"}}] * 2}, Action)
