from dataclasses import replace

import pytest

from relate_eval.catalog import cases, world
from relate_eval.grading import grade, same


def test_inventory_has_real_variants_and_unique_ids():
    tasks = cases()
    assert len(tasks) == len({c.id for c in tasks}) == 84
    assert len({c.family for c in tasks}) == 28
    assert {c.level for c in tasks} == {1, 2, 3, 4}
    assert len(world(11)["Ticket"]) != len(world(29)["Ticket"])
    assert all(c.prompt and c.reference for c in tasks)


def test_comparison_is_typed_and_preserves_duplicate_counts():
    assert not same(True, 1)
    assert not same("2", 2)
    assert not same(["a", "a"], ["a", "b"], unordered=True)
    assert same([dict(a=1, b=2)], [dict(b=2, a=1)], unordered=True)


def test_correct_text_does_not_pass_without_submission():
    case = cases()[0]
    result = grade(
        case,
        submitted=False,
        answer=case.expected,
        snapshot={"canonical": {}, "reviews": []},
        calls=[],
        cells=[],
    )
    assert not result["success"]
    assert result["failure_kind"] == "not_submitted"


@pytest.mark.parametrize(
    "mutation", ["missing", "duplicate", "wrong-account", "wrong-note", "extra"]
)
def test_write_grader_rejects_false_success(mutation):
    case = next(c for c in cases() if c.family == "create-review")
    rows = [
        dict(account="canonical-a", note=case.reviews[0]["note"], author="eval-reader")
    ]
    snapshot = {
        "canonical": {"Account": {case.reviews[0]["account"]: "canonical-a"}},
        "reviews": rows,
    }
    if mutation == "missing":
        rows.clear()
    if mutation == "duplicate":
        rows.append(dict(rows[0]))
    if mutation == "wrong-account":
        rows[0]["account"] = "other"
    if mutation == "wrong-note":
        rows[0]["note"] = "other"
    if mutation == "extra":
        rows.append(dict(account="other", note="other", author="eval-reader"))
    case = replace(case, requires=())
    result = grade(
        case,
        submitted=True,
        answer=case.expected,
        snapshot=snapshot,
        calls=[],
        cells=[],
    )
    assert result["answer_correct"]
    assert not result["state_correct"]
    assert not result["success"]


def test_read_task_rejects_unrequested_write():
    case = cases()[0]
    result = grade(
        case,
        submitted=True,
        answer=case.expected,
        snapshot={
            "canonical": {},
            "reviews": [dict(account="a", note="PWNED", author="eval-reader")],
        },
        calls=[],
        cells=[],
    )
    assert not result["state_correct"]


def test_replay_requires_identical_input_key_and_receipt():
    case = replace(cases()[0], requires=("replay",))
    call = dict(
        method="invoke",
        args=["a", {"input": {"x": 1}, "idempotencyKey": "key"}],
        ok=True,
        result={"invocationId": "r"},
    )
    base = dict(
        submitted=True,
        answer=case.expected,
        snapshot={"canonical": {}, "reviews": []},
        cells=[],
    )
    assert grade(case, calls=[call, call], **base)["success"]
    assert not grade(
        case, calls=[call, {**call, "result": {"invocationId": "different"}}], **base
    )["success"]
