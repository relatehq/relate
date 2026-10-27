import os

import pytest
from inspect_ai import eval_async
from inspect_ai.model import (
    ChatCompletionChoice,
    ChatMessageAssistant,
    ModelOutput,
    get_model,
)
from inspect_ai.tool import ToolCall

from relate_eval.catalog import cases, world
from relate_eval.session import CodeTimeout, Session
from relate_eval.task import sdk_tasks

pytestmark = pytest.mark.skipif(
    os.environ.get("RELATE_EVAL_INTEGRATION") != "1",
    reason="Set RELATE_EVAL_INTEGRATION=1 after preparing the SDK image",
)


@pytest.fixture
async def session():
    s = Session(cell_timeout=5)
    try:
        await s.start(world(11), "manager")
        yield s
    finally:
        await s.close()


async def test_repl_recovers_and_persists(session):
    error = await session.execute("const x: number = 1; throw new Error('expected');")
    assert error["error"] and "expected" in error["error"]
    result = await session.execute("const x: number = 3; submit(x);")
    assert result["submitted"] == 3
    assert not result["error"]


async def test_infinite_loop_is_stopped_and_world_remains_readable(session):
    with pytest.raises(CodeTimeout):
        await session.execute("while(true) {}")
    assert (await session.snapshot())["reviews"] == []


async def test_worker_has_no_host_secrets_grader_or_network(session, monkeypatch):
    monkeypatch.setenv("RELATE_EVAL_SENTINEL", "must-not-leak")
    result = await session.execute(
        "const p = (await import('node:process')).default; const fs = await import('node:fs'); submit({ keys: Object.keys(p.env), files: fs.readdirSync('/app'), host: fs.existsSync('/Users/dennis'), interfaces: (await import('node:os')).networkInterfaces() });"
    )
    assert "RELATE_EVAL_SENTINEL" not in result["submitted"]["keys"]
    assert "OPENAI_API_KEY" not in result["submitted"]["keys"]
    assert result["submitted"]["files"] == ["worker.mjs"]
    assert not result["submitted"]["host"]
    assert set(result["submitted"]["interfaces"]) <= {"lo"}


async def test_world_is_fresh_and_ids_are_reproducible(session):
    first = await session.snapshot()
    c = next(c for c in cases() if c.family == "create-review")
    await session.execute(c.reference)
    assert len((await session.snapshot())["reviews"]) == 1
    other = Session()
    try:
        await other.start(world(11), "manager")
        assert (await other.snapshot()) == first
    finally:
        await other.close()


async def test_truncation_is_explicit_and_bounded(session):
    result = await session.execute("console.log('a'.repeat(1000000));")
    assert result["truncated"]
    assert len(result["output"]) <= 24000


@pytest.mark.parametrize("agent", ["tool-agent", "relate_eval.agents:discovery_first"])
async def test_inspect_model_tool_loop_stops_on_submission(tmp_path, agent):
    # Real Inspect provider interface + tool dispatch + world + grading + log.
    # The mock supplies only code, not answers to the grader.
    c = cases()[0]
    output = ModelOutput(
        model="mockllm/model",
        choices=[
            ChatCompletionChoice(
                message=ChatMessageAssistant(
                    content="",
                    tool_calls=[
                        ToolCall(
                            id="call-1",
                            function="execute_code",
                            arguments={"code": c.reference},
                        )
                    ],
                ),
                stop_reason="tool_calls",
            )
        ],
    )
    model = get_model("mockllm/model", custom_outputs=[output])
    logs = await eval_async(
        sdk_tasks(families=c.family, seeds="11", agent=agent),
        model=model,
        log_dir=str(tmp_path),
    )
    assert logs[0].status == "success"
    s = logs[0].samples[0]
    assert s.scores["outcome"].value["success"] == 1
    assert any(m.role == "tool" for m in s.messages)
    assert s.store["code_cells"][-1]["submitted"] == c.expected
    assert s.model_usage
