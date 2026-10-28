"""Integration checks for the actual Relate runtime and container RPC."""
import os
from pathlib import Path
import sys
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from agents.agency_relate import RelateBridge


@pytest.mark.skipif(not os.environ.get("AGENCY_EXECUTOR_IMAGE"), reason="Requires the agency container image")
def test_source_calls_parallel_results_receipt_replay_and_isolation():
    calls = []
    def echo(args):
        calls.append(args)
        return {"nested": {"text": args["text"]}}
    bridge = RelateBridge([{"name": "echo", "description": "Return nested input", "parameters": {
        "type": "object", "properties": {"text": {"type": "string"}}, "required": ["text"]}}], {"echo": echo})
    try:
        result = bridge.call({"type": "execute", "code": '''
          const first = await Promise.all(["a", "b"].map(text => graph.actions.echo({
            input: {arguments: JSON.stringify({text})}, idempotencyKey: text
          })));
          const replay = await graph.actions.echo({input:{arguments:JSON.stringify({text:"a"})},idempotencyKey:"a"});
          return {first, replay, hasProviderKey: Boolean(process.env.OPENAI_API_KEY),
            hasHostEnvFile: (await import('node:fs')).existsSync('/workspace/.env')};
        '''})
        assert result["status"] == "succeeded"
        assert [r["output"]["value"] for r in result["result"]["first"]] == [
            '{"nested":{"text":"a"}}', '{"nested":{"text":"b"}}']
        assert result["result"]["replay"]["invocationId"] == result["result"]["first"][0]["invocationId"]
        assert result["result"]["hasProviderKey"] is False
        assert result["result"]["hasHostEnvFile"] is False
        assert calls == [{"text": "a"}, {"text": "b"}]
        assert bridge.records == [{"name": "echo", "arguments": args, "result": {"nested": args}} for args in calls]
    finally:
        bridge.close()
