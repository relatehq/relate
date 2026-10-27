import pytest

from relate_eval.report import compare, reliability, summarize


def manifest():
    return dict(
        run="test",
        suite_version="1",
        oracle=False,
        schedule=[
            dict(agent="a", task="t", family="f", level=1, epoch=i) for i in (1, 2, 3)
        ],
    )


def test_missing_and_provider_errors_remain_in_denominator():
    report = summarize(
        manifest(),
        [
            dict(agent="a", task="t", epoch=1, status="scored", success=True),
            dict(agent="a", task="t", epoch=2, status="error", success=False),
        ],
    )
    s = next(s for s in report["slices"] if s["slice"] == "all")
    assert (s["planned"], s["scored"], s["passed"], s["errors"], s["missing"]) == (
        3,
        1,
        1,
        1,
        1,
    )
    assert s["success_over_planned"] == 1 / 3
    assert s["success_over_scored"] == 1
    assert s["reliability"]["2"]["eligible_tasks"] == 0
    assert not report["complete"]


def test_reliability_uses_trials_not_variants():
    assert reliability([True, False, True], 2) == {
        "pass_at_k": 1,
        "pass_power_k": 1 / 3,
    }
    assert reliability([True], 2) == {"pass_at_k": None, "pass_power_k": None}


def test_duplicate_trial_is_not_silently_counted():
    row = dict(agent="a", task="t", epoch=1, status="scored", success=True)
    with pytest.raises(ValueError, match="duplicate"):
        summarize(manifest(), [row, row])


def test_paired_comparison_does_not_match_unrelated_tasks():
    result = compare(
        [
            dict(task="x", epoch=1, status="scored", success=True),
            dict(task="y", epoch=1, status="error", success=False),
        ],
        [
            dict(task="x", epoch=1, status="scored", success=False),
            dict(task="z", epoch=1, status="scored", success=True),
        ],
    )
    assert result == dict(
        paired=1,
        left_only=1,
        right_only=1,
        incomplete_pairs=0,
        both_pass=0,
        left_only_pass=1,
        right_only_pass=0,
        neither_pass=0,
    )


def test_token_totals_include_cache_without_double_counting():
    from inspect_ai.model import ModelUsage

    from relate_eval.report import usage_totals

    result = usage_totals(
        [
            ModelUsage(
                input_tokens=10,
                input_tokens_cache_read=20,
                input_tokens_cache_write=30,
                output_tokens=5,
            )
        ]
    )
    assert result == dict(
        input_tokens=60,
        uncached_input_tokens=10,
        cached_input_tokens=20,
        cache_write_tokens=30,
        output_tokens=5,
    )
