import importlib.util
from pathlib import Path

spec = importlib.util.spec_from_file_location("agency_agent", Path(__file__).parents[1] / "agents/agency.py")
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


def test_embedded_results_not_duplicated_and_ids_preserved():
    calls = [{"name": "get_order", "arguments": {"id": "o1"}, "result": {"status": "shipped"}}]
    continuation = [{"type": "function_call", "call_id": "original-id", "name": "get_order", "arguments": '{"id":"o1"}'}]
    messages = module.messages_for([
        {"role": "assistant", "content": "", "tool_calls": calls},
        {"role": "tool", "content": calls},
    ], {module.signature("", calls): continuation})
    assert len(messages) == 2
    assert messages[0]["continuation"] == continuation
    assert messages[1]["content"][0]["id"] == "original-id"
    assert 'shipped' in messages[1]["content"][0]["content"]


def test_collapsed_history_does_not_reuse_unrelated_continuation():
    messages = module.messages_for([{"role": "assistant", "content": "new"}], {"old": [{"type": "reasoning"}]})
    assert "continuation" not in messages[0]
