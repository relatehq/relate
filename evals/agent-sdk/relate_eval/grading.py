"""Deterministic answer, state and requested-procedure checks."""

import json

from .catalog import Case, world


def canonical(value):
    return json.dumps(
        value,
        sort_keys=True,
        separators=(",", ":"),
        ensure_ascii=False,
        allow_nan=False,
    )


def same(actual, expected, unordered=False):
    if unordered:
        return (
            isinstance(actual, list)
            and isinstance(expected, list)
            and sorted(map(canonical, actual)) == sorted(map(canonical, expected))
        )
    return canonical(actual) == canonical(expected)


def grade(case: Case, *, submitted, answer, snapshot, calls, cells):
    expected_reviews = [
        dict(
            account=snapshot["canonical"]["Account"][r["account"]],
            note=r["note"],
            author="eval-reader",
        )
        for r in case.reviews
    ]
    actual_reviews = [
        {key: row.get(key) for key in ("account", "note", "author")}
        for row in snapshot["reviews"]
    ]
    expected_answer = case.expected
    if case.family == "cursor-page":
        rows = world(case.seed)
        visible = {a["id"] for a in rows["Account"] if a["team"] == "north"}
        tickets = [t for t in rows["Ticket"] if t["account"] in visible]
        tickets.sort(key=lambda t: snapshot["canonical"]["Ticket"][t["id"]])
        expected_answer = [t["subject"] for t in tickets[5:10]]
    answer_ok = submitted and same(answer, expected_answer, case.unordered)
    state_ok = same(actual_reviews, expected_reviews, unordered=True)
    methods = {c["method"] for c in calls if c.get("ok")}
    checks = {}
    for required in case.requires:
        if required == "cursor":
            checks[required] = any(
                c["method"] == "query"
                and c.get("ok")
                and len(c["args"]) > 1
                and c["args"][1].get("cursor")
                for c in calls
            )
        elif required == "replay":
            invocations = [c for c in calls if c["method"] == "invoke" and c.get("ok")]
            checks[required] = any(
                a["args"] == b["args"]
                and a["result"]["invocationId"] == b["result"]["invocationId"]
                for i, a in enumerate(invocations)
                for b in invocations[i + 1 :]
            )
        elif required == "conflict":
            checks[required] = any(
                c["method"] == "invoke"
                and not c.get("ok")
                and c["error"].get("code") == "conflict"
                for c in calls
            )
        else:
            checks[required] = required in methods
    procedure_ok = all(checks.values())
    return dict(
        success=bool(answer_ok and state_ok and procedure_ok),
        answer_correct=bool(answer_ok),
        state_correct=state_ok,
        procedure_correct=procedure_ok,
        submitted=submitted,
        procedure_checks=checks,
        failure_kind="none"
        if answer_ok and state_ok and procedure_ok
        else "not_submitted"
        if not submitted
        else "state"
        if not state_ok
        else "procedure"
        if not procedure_ok
        else "answer",
        cells=len(cells),
        sdk_calls=len(calls),
        sdk_errors=sum(not c.get("ok") for c in calls),
        cell_errors=sum(bool(c.get("error")) for c in cells),
        truncated_outputs=sum(bool(c.get("truncated")) for c in cells),
        expected_answer=expected_answer,
        actual_answer=answer,
        expected_reviews=expected_reviews,
        actual_reviews=actual_reviews,
    )
