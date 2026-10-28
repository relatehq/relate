from pathlib import Path
import sys
from types import SimpleNamespace
import pytest
from pydantic import BaseModel

HERE = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(HERE.parents[4] / "benchmarks/media-agency/artifacts/upstream/continual-learning"))
import relate_system


class Choice(BaseModel):
    choice: str


def test_relate_submission_validates_choice_and_keeps_only_visible_history(monkeypatch):
    closed = []
    class Bridge:
        instructions = "test interface"
        def __init__(self, tools, handlers):
            self.submit = handlers["respond"]
        def call(self, message):
            return self.submit({"choice": "A"})
        def close(self):
            closed.append(True)
    monkeypatch.setattr(relate_system, "RelateBridge", Bridge)
    system = relate_system.AgencyLunaRelate()
    monkeypatch.setattr(system, "complete", lambda *args: {"usage": {"outputTokens": 10}, "content": [
        {"type": "tool_call", "id": "c1", "name": "execute", "input": {"code": "choose"}}]})
    reply = system.respond(SimpleNamespace(prompt="Pick one", response_schema=Choice, hidden="secret grader"))
    assert reply.action == Choice(choice="A")
    assert len(system.messages) == 2
    assert system.messages[-1] == {"role": "assistant", "content": [{"type": "text", "text": '{"choice":"A"}'}]}
    assert "secret grader" not in str(system.messages)
    assert closed == [True]
    system.reset()
    assert system.messages == []


def test_no_submission_is_an_error_and_executor_is_closed(monkeypatch):
    closed = []
    class Bridge:
        instructions = "test interface"
        def __init__(self, *args): pass
        def close(self): closed.append(True)
    monkeypatch.setattr(relate_system, "RelateBridge", Bridge)
    system = relate_system.AgencyLunaRelate()
    monkeypatch.setattr(system, "complete", lambda *args: {"usage": {"outputTokens": 10}, "content": [{"type": "text", "text": "I cannot choose"}]})
    with pytest.raises(ValueError, match="without submitting"):
        system.respond(SimpleNamespace(prompt="Pick", response_schema=Choice))
    assert closed == [True]
