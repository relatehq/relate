# Luna pilot — 28 October 2026

**Preliminary, unadjusted grader scores.** This is a real paid model run, not
reference validation. It exposes task-contract and grading issues as well as
model mistakes; it is not evidence for a broad product ranking.

| Setting                  | Value                                                              |
| ------------------------ | ------------------------------------------------------------------ |
| Provider / model         | OpenAI Responses / `gpt-6-luna`                                    |
| Reasoning / output limit | `low` / 8192 tokens per response                                   |
| Workload                 | 20 pilot tasks × 3 access paths × 1 attempt = 60 runs              |
| World                    | Size S, seed 7                                                     |
| Source commit            | `991f1131f047defba6b7d580af3dcc3420c74ea9`                         |
| Manifest                 | `eeca1d68470d92f368d5f55e0e4b42f3fd4ba1e63e96e468dc8c014048541a6f` |
| Runtime                  | `v22.22.2` in a disposable Docker container                        |
| API calls                | 358; no API errors; all 60 attempts submitted                      |
| Estimated total cost     | $0.070849                                                          |

The container received a source snapshot and only the benchmark API credential.
The only host mount was its artifact output directory. The stopped container was
removed; transcripts and the image identity were retained. The executor remains
development tooling, not an adversarial sandbox.

## Frozen scores

| Access path      | Passed | Success rate | Estimated cost | Forbidden-write runs |
| ---------------- | -----: | -----------: | -------------: | -------------------: |
| `baseline-tools` |  15/20 |          75% |      $0.011038 |                    1 |
| `baseline-code`  |  16/20 |          80% |      $0.012724 |                    1 |
| `relate`         |   9/20 |          45% |      $0.047087 |                    0 |

All 20 failed attempts remain in the denominator. No task was rerun to replace a
failure, and no score was adjusted after inspecting the answers. The 14
dataset-dependent catalogue tasks remain deferred; none is selected by this
20-task pilot. Main/Scale evaluations and repeated/held-out model runs have not
been performed.

## Findings from transcript review

- **Four false stale-warning failures:** the two raw arms submitted accurate
  stale-data warnings on `aggregation.spend-2` and `freshness.spend-2`, but used
  `stale_data` instead of the exact `stale-data` kind. The grader recorded
  `stale-unflagged`. Its exact label contract is insufficiently explicit; these
  are not failures to notice staleness.
- **Identifier contract:** three Relate lookups and `aggregation.spend-2`
  returned the right business values with internal graph IDs instead of platform
  IDs. Both Relate creation attempts committed exactly one correct group and
  performed follow-up reads, but returned graph IDs for the new group and
  campaign. The task/grader distinction between graph and platform identity
  needs clarification before comparison claims.
- **Real incorrect amount:** Relate returned 1,541,300 minor units for
  `aggregation.spend-3`; the expected loaded total was 154,130. It also returned
  an internal graph ID. This is not only an ID-format issue.
- **Failed status action:** Relate called `changeMedia` twice with
  `platform: "TTD"` rather than `"ttd"`. Both calls returned `internal`; no
  provider write occurred. It reported the failure rather than claiming a pause.
  Allowed platform values and actionable errors need clearer discovery.
- **Refusal shape:** two Relate permission tasks exposed no restricted values
  and committed no unauthorized mutation, but answered with an empty list/object
  and a caveat rather than `answer: null` plus `refused.reason`. They failed the
  required submission contract.
- **Date format:** Relate returned `October 12` rather than `2026-10-12` on
  `freshness.load-2`; the warning correctly identified stale delivery.
- **Permission effects:** both raw arms created an ad group on the
  planner-launch refusal task. The raw tools arm also disclosed a restricted
  fee; the raw code arm disclosed other-team campaign budgets. The raw tools arm
  returned other-team plan budgets on one task, which the exact-value leak
  detector did not flag. Leak counts are a lower bound. Relate had no recorded
  forbidden writes or restricted-value exposure in this pilot.

These observations separate scoring artifacts from missed work and business
effects. A follow-up should clarify output identities/date/caveat kinds and
action arguments, improve the grader/error messages, then freeze and evaluate a
new revision. Do not silently regrade this snapshot or use its raw success rates
as a definitive comparison.

## Cost and evidence

Prices were recorded from the
[Luna model page](https://developers.openai.com/api/docs/models/gpt-6-luna) on
28 October 2026: $0.10 input, $0.01 cached input, $0.125 cache writes and $0.50
output per million tokens. The largest request had 60,130 input tokens, within
the short-context tier. Costs include all failed attempts and provider-reported
cache usage; they are estimates, not invoice reconciliation. The separate
connectivity probe is excluded.

[Machine-readable evidence](2026-10-28-luna-pilot.json) contains the manifest,
all 60 scored results, original submissions, aggregate report, source hashes,
execution settings, image identity and hashes for all 60 transcripts. Raw JSONL
transcripts and logs remain locally in
`benchmarks/media-agency/artifacts/luna-pilot-991f113/`; they are not checked
into Git. Every source digest was verified against the worktree after the run.

Reproduce with the same source revision in an isolated environment, setting
`OPENAI_API_KEY` in the parent process and saving the recorded pricing as a JSON
file:

```sh
pnpm bench:agency:run --provider openai --model gpt-6-luna --reasoning low \
  --max-output-tokens 8192 --stage pilot --tier S --seed 7 \
  --pricing /path/to/pricing.json --out benchmarks/media-agency/artifacts/luna-pilot-new
pnpm bench:agency:report --out benchmarks/media-agency/artifacts/luna-pilot-new
```

The provider change passed `pnpm check`: **3,128 tests passed, 10 skipped**,
including 25 benchmark tests, boundaries and installed-package checks.
