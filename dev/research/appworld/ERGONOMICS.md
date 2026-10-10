# Independent SDK and graph ergonomics experiments

**Retained: contact-group descriptions in the research graph. No new SDK PR.**
Only the contact-description arm met the frozen confirmation rule: 18/24
successes versus 16/24 for the unchanged controls, with essentially unchanged
turns and 6.5% fewer input tokens. The receipt, error and query SDK spikes did
not qualify. Their code remains outside the research branch and outside main.

All **120 episodes** are retained: 1,783 turns, 54.24 minutes of summed episode
wall time and **$1.1077 estimated model cost**. Controls themselves varied from
7/12 to 9/12. These are pilot results, not a general accuracy claim.

The retained graph change is commit `cf51922`: three description strings and an
updated existing description assertion. It is the same contact variant evaluated
independently in both rounds. The date description is not combined with it. No
SDK package differs from main `2cf7f92` on the research branch.

One intervention per arm, using unchanged nano prompts, six training instances
and the official AppWorld evaluator. SDK implementation changes live only in
separate main-based branches; the research branch contains the experiment plan,
analysis and evidence.

Protocol frozen before execution: [ERGONOMICS-PLAN.md](ERGONOMICS-PLAN.md).
Machine-readable sanitized evidence:
[ergonomics.json](evidence/ergonomics.json).

## Results

| Arm                            | Round | Passed | Writes | Reads | Mean turns | Mean input tokens | Mean output tokens | Mean seconds | Total minutes | Model cost |
| ------------------------------ | ----- | ------ | ------ | ----- | ---------- | ----------------- | ------------------ | ------------ | ------------- | ---------- |
| Unchanged control              | v1    | 7/12   | 1/6    | 6/6   | 14.08      | 114,488           | 2,818              | 28.9         | 5.78          | $0.1161    |
| Unchanged control              | v2    | 9/12   | 3/6    | 6/6   | 15.17      | 103,844           | 2,610              | 27.4         | 5.49          | $0.1120    |
| Graph contact descriptions     | v1    | 8/12   | 2/6    | 6/6   | 15.67      | 113,082           | 2,792              | 29.2         | 5.83          | $0.1199    |
| Graph contact descriptions     | v2    | 10/12  | 4/6    | 6/6   | 13.67      | 90,972            | 2,268              | 24.9         | 4.98          | $0.0995    |
| Graph date description         | v1    | 8/12   | 2/6    | 6/6   | 12.58      | 90,831            | 1,863              | 21.4         | 4.28          | $0.0939    |
| Graph date description         | v2    | 7/12   | 1/6    | 6/6   | 14.00      | 83,604            | 2,001              | 22.9         | 4.58          | $0.0958    |
| SDK request error messages     | v1    | 6/12   | 1/6    | 5/6   | 17.17      | 118,469           | 2,612              | 30.0         | 6.01          | $0.1212    |
| SDK query consumption examples | v1    | 7/12   | 1/6    | 6/6   | 14.67      | 101,263           | 2,436              | 26.6         | 5.32          | $0.1095    |
| SDK query consumption examples | v2    | 7/12   | 1/6    | 6/6   | 16.33      | 128,352           | 2,574              | 28.0         | 5.60          | $0.1214    |
| SDK action receipt discovery   | v1    | 6/12   | 1/6    | 5/6   | 15.25      | 111,018           | 2,921              | 31.8         | 6.36          | $0.1184    |

Total recorded model cost: **$1.1077**. All attempts are retained. Times sum
measured episode durations (setup/acquisition, model, execution and evaluation),
not elapsed project time. Background package checks and provider variability
make timing descriptive rather than a controlled speed comparison. Input tokens
include accumulated context replay; they are not unique prompt text.

## Promotion decisions

| Change                         | Screening qualifies | Confirmation | Combined result | Confirmed improvement |
| ------------------------------ | ------------------- | ------------ | --------------- | --------------------- |
| SDK action receipt discovery   | No                  | Not run      | 7/12 → 6/12     | No                    |
| SDK request error messages     | No                  | Not run      | 7/12 → 6/12     | No                    |
| SDK query consumption examples | Yes                 | Completed    | 16/24 → 14/24   | No                    |
| Graph contact descriptions     | Yes                 | Completed    | 16/24 → 18/24   | Yes                   |
| Graph date description         | Yes                 | Completed    | 16/24 → 15/24   | No                    |

Screening requires more official successes, or equal successes and at least 10%
fewer mean turns or input tokens without over 10% regression in the other.
Confirmation must not lose accuracy to a second fresh control; pooled screening
plus confirmation must still satisfy the improvement rule. No treatment is
edited after its screening run. These thresholds select a practical pilot
candidate, not statistical significance.

## What changed, precisely

### SDK action receipt discovery

Commit `ed01e88`, based directly on main `2cf7f92`. Action detail gains an
invocation example, succeeded/failed receipt shapes, the `receipt.output`
location and stable-key retry guidance. No changes to action execution,
persistence or provider calls.

```ts
const receipt = await relate.actions.example({
  input: {/* described action fields */},
  idempotencyKey: 'same-intended-operation',
});
if (receipt.state === 'succeeded') console.log(receipt.output);
```

### SDK request error messages

Commit `245cab7`, independently based on main. Read-error text includes the
authorized accepted alternatives that already exist in structured issues.
Initial action input validation gains operation and field paths after
authorization. It does not expose provided values or enrich
handler-output/internal failures.

```text
Before: ActionError: invalid
After:  ActionError: invalid in likeTransaction:
        - input.transaction: Expected a nonempty Relate object ID; required value is missing.

Before: where.createdAt.gte: unsupported filter operator for this property.
After:  where.createdAt.gte: unsupported filter operator for this property. Accepted: eq, in.
```

The exact punctuation and error strings are covered by the implementation tests;
the examples above illustrate the caller-facing change. An unauthorized and
nonexistent action retain indistinguishable errors.

### SDK query consumption examples

Commit `fbf9654`, independently based on main. Object discovery gains two
executable examples on the existing query contract. The API itself is unchanged.

```ts
// All pages: keep the lazy handle unawaited.
for await (const record of relate.objects.Example.query({})) {
  console.log(record.data);
}

// One page: awaiting consumes one page, not an async iterable.
const page = await relate.objects.Example.query({});
console.log(page.data, page.meta);
```

The discovery examples are relative to the consumer (`objects.Example...`), like
its other documented signatures. Tests execute both examples against a two-page
loader.

### Graph contact descriptions

[Exact tested patch](evidence/graph-contact-description.patch), against the
frozen baseline graph. This change is now retained in the research graph.

Main SDK unchanged. Three description strings explain that selecting a contact
group requires both `owner` and `kind`; one person may have multiple labels;
transaction sender/receiver direction does not imply group membership. No graph
shape, IDs, acquisition, schema or values change.

### Graph date description

[Exact tested patch](evidence/graph-date-description.patch), kept as an
experiment.

Main SDK unchanged. One description explicitly says the source date is a
timezone-free local-clock string, supports `eq`/`in` rather than range
operators, and requires same-format client-side bounds for range selection. This
does not add a datetime type or change source values.

## Error mechanisms

| Arm / round | Write-state passes / 6 | Date-range error turns | Awaited-page iteration error turns | Action validation turns | Redeclaration turns | Literal-print turns |
| ----------- | ---------------------- | ---------------------- | ---------------------------------- | ----------------------- | ------------------- | ------------------- |
| baseline-v1 | 1/6                    | 6                      | 1                                  | 7                       | 39                  | 27                  |
| baseline-v2 | 3/6                    | 5                      | 5                                  | 3                       | 35                  | 38                  |
| contacts-v1 | 3/6                    | 7                      | 5                                  | 5                       | 36                  | 38                  |
| contacts-v2 | 4/6                    | 5                      | 3                                  | 4                       | 26                  | 25                  |
| dates-v1    | 2/6                    | 0                      | 3                                  | 6                       | 16                  | 26                  |
| dates-v2    | 2/6                    | 0                      | 4                                  | 4                       | 18                  | 41                  |
| errors-v1   | 1/6                    | 5                      | 1                                  | 7                       | 37                  | 51                  |
| query-v1    | 1/6                    | 7                      | 3                                  | 6                       | 29                  | 35                  |
| query-v2    | 1/6                    | 6                      | 1                                  | 4                       | 39                  | 30                  |
| receipts-v1 | 1/6                    | 7                      | 7                                  | 4                       | 44                  | 29                  |

Write-state passes isolate the evaluator’s mutation checks; they do not replace
official task success or completion. Mechanism counts are descriptive string
classifications of recorded tool output, not official evaluator labels. They
count turns, not individual failed calls. Caught action errors count when
printed; silent caught errors cannot be detected this way. Categories can
overlap across mechanism columns. Literal-print classification requires a cell
containing only string-literal console logs; it does not classify all
unproductive reasoning.

## Successful cases compared like for like

| Change                         | Cases successful in both | Mean turns control → candidate | Mean input tokens control → candidate |
| ------------------------------ | ------------------------ | ------------------------------ | ------------------------------------- |
| SDK action receipt discovery   | 5                        | 9.20 → 7.80                    | 39,438 → 37,645                       |
| SDK request error messages     | 5                        | 9.00 → 8.60                    | 37,140 → 36,341                       |
| SDK query consumption examples | 13                       | 11.31 → 10.62                  | 63,667 → 58,849                       |
| Graph contact descriptions     | 13                       | 11.31 → 10.23                  | 63,667 → 56,705                       |
| Graph date description         | 14                       | 11.43 → 10.29                  | 64,612 → 52,340                       |

Pairs match task and repeat index within a round. They are fresh model draws,
not the same provider seed or identical graph UUIDs. This success-conditioned
subset is useful diagnostically but cannot replace all-attempt accuracy or prove
causal efficiency.

## Concrete trajectory findings

- **Receipt discovery, `sdk-nano-ergonomics-receipts-v1/afc0fce_3__sdk__1`:**
  action input failed at turn 19; action detail, including the new receipt
  contract, was read at turn 20. Two redeclaration errors followed, then
  successful writes at turn 23 and completion at turn 24. The model inspected
  receipt states correctly. This is a useful local recovery, but the arm lost a
  read success elsewhere and did not improve total accuracy.
- **Error messages, `sdk-nano-ergonomics-errors-v1/afc0fce_2__sdk__0`:** the
  field-specific message identified `input.transaction` at turns 22 and 27. The
  model finally generated the correct nested input at turn 28, but that cell
  failed on an already-declared variable before any write. The episode exhausted
  its budget. Clear SDK errors did not remove the independent REPL recovery
  problem.
- **Error messages, `sdk-nano-ergonomics-errors-v1/d0b1f43_1__sdk__1`:** the
  model discovered the correct group, then accidentally spread the first ID
  string into characters while manually rebuilding an array. It later removed
  the unsupported date predicate after the improved error, but still queried
  using the corrupted ID list and submitted the wrong total. This lost read
  cannot be explained simply as an error-message failure or fixed by adding more
  operator documentation.
- **Baseline, `sdk-nano-ergonomics-baseline-v1/afc0fce_2__sdk__0`:** the model
  printed a literal status and immediately called completion with failure in its
  first cell. This was a valid model response, not infrastructure failure. It
  remains in the denominator and makes all-attempt baseline mean turns unusually
  low.

The observations above explain recorded behavior; they do not establish which
wording caused a stochastic model choice. In particular, a repair to one
interface mistake can coexist with a later error in targeting, pagination,
identifiers, completion or JavaScript state.

The contact-description screen supplies a more direct graph-specific example. In
`sdk-nano-ergonomics-contacts-v1/afc0fce_3__sdk__0`, the model queried contact
relationships using both owner and kind at turn 16, selected the intended
payment records, wrote at turn 22 and completed at turn 23. In repeat 1 of the
same task it also selected the correct group and finished the correct writes at
turn 27, but spent its last turn attempting verification and hit another
redeclaration. All world-state checks passed; official success still failed
because completion was missing. These outcomes support separating **target
selection**, **write correctness** and **task submission**, without replacing
the official success measure.

The query-example screen retained all six read successes and traded one
successful write case for another. Matched successful read cases averaged 10.33
→ 8.67 turns and 46,860 → 39,449 input tokens. However, awaited-page iteration
errors were 1 → 3 across all episodes. Its token reduction is an observed
screening result; the traces do not establish that the examples reduced the
specific query-shape error.

**Query confirmation reversed the screening efficiency result.** The unchanged
candidate again scored 7/12, while the second control scored 9/12. Across both
rounds: 14/24 versus 16/24 successes; 15.50 versus 14.63 mean turns; 114,807
versus 109,166 input tokens. Awaited-page error turns did fall from 6 to 4 in
the pooled data, and the 13 cases successful in both arms used modestly fewer
turns/tokens, but neither observation overrules the loss in overall task
success. No SDK PR is justified by this experiment.

**Contact descriptions passed confirmation, with uneven effects across tasks.**
The confirmation arm scored 10/12 versus 9/12; pooled success is 18/24 versus
16/24 (writes 6/12 versus 4/12, reads 12/12 in both). Mean turns are 14.67
versus 14.63, and input tokens 102,027 versus 109,166. Both friend-write
confirmations succeeded after explicitly selecting the friend contact kind. In
`sdk-nano-ergonomics-contacts-v2/afc0fce_2__sdk__0`, turns 13–14 inspect labels
through owner-scoped traversal and construct the friend set before matching
payments. Repeat 1 uses owner + kind predicates at turn 16. However, both
coworker confirmations lost successes held by the control and still failed exact
target-set checks. The wording improves the aggregate pilot result; it is not a
guarantee that every task will respect the group restriction.

**Date wording fixed its targeted error but did not confirm task accuracy.**
Unsupported date-range error turns were **11 in the two controls and 0 in the
two date arms**. Pooled mean turns fell 14.63 → 13.29 and input tokens fell
109,166 → 87,217. However, confirmation scored 7/12 versus 9/12 and pooled
success was 15/24 versus 16/24. We therefore retain it as a reproducible
experimental patch, not the default graph. This is the clearest example of a
localized ergonomic improvement that is insufficient for the overall task.

## Reproduction and validation

- Main base: `2cf7f9283d807ec83e183895cf2e8141ba045ca3`.
- Nano low reasoning; 28 turns; 4096 output tokens/request; 14000 generated
  tokens/episode; 14000 visible characters; world seed 100; no provider seed.
- Six tasks: `afc0fce_1`, `afc0fce_2`, `d0b1f43_1`, `afc0fce_3`, `e7a10f8_3`,
  `82e2fac_1`, two repeats each.
- Original APIs remain unavailable to the SDK agent. Host acquisition and writes
  use the existing research integration.
- Unchanged prompts, runner, acquisition and REPL hashes are verified against
  the fresh baseline. Only the graph source hash differs for graph-description
  arms. SDK commits and package diffs are recorded per run. Exact SDK patches
  are retained in the encrypted archive, with public SHA-256 hashes, so negative
  spikes need not remain published branches.
- Full `pnpm check` passes independently: receipts 945 tests, errors 948 tests,
  query examples 946 tests, including Postgres integration and installed-package
  smoke checks.
- Protected prompts, data, outputs and evaluator details remain local or in the
  official AppWorld encrypted bundle; public evidence contains sanitized metrics
  and paraphrased analysis.

```sh
dev/research/appworld/.venv/bin/python dev/research/appworld/sdk_runner.py \
  --run sdk-nano-ergonomics-ARM-v1 \
  --tasks afc0fce_1 afc0fce_2 d0b1f43_1 afc0fce_3 e7a10f8_3 82e2fac_1 \
  --conditions sdk --repeats 2 --steps 28 --max-cost-usd 0.4 \
  --credentials /path/to/authorized/local.env
dev/research/appworld/.venv/bin/python dev/research/appworld/ergonomics_compare.py
```

Run each SDK arm in its own checked-out commit with the same ignored harness and
original graph; graph arms use main packages plus only their frozen description
edit. Do not reuse a run directory. The runner freezes its source files and
configuration alongside every run.

## Limits

This is a six-instance training diagnostic with multiple candidate comparisons,
not the 168-task test-normal benchmark. A successful screening arm may be a
chance winner; confirmation and a separate holdout remain important. Sequential
arm order is not randomized. One baseline episode immediately submitted failure
after a literal print; it is retained, which lowers baseline mean turns without
representing good performance. No prompt, model or REPL changes were smuggled
into SDK arms.

## Next tests

1. Keep the retained contact description as the new research baseline, then test
   adding the date wording as a separate increment. Their combination has not
   been evaluated; the date cue addresses a different failure mechanism.
2. Interleave control/candidate episodes and use more repeats plus new held-out
   task instances. The 7/12 → 9/12 movement in unchanged controls shows why a
   single two-repeat comparison is unreliable.
3. Test REPL binding/recovery ergonomics separately and equally in raw TS and
   SDK environments. The two controls spent 74 turns on redeclaration errors.
   This is an environment concern, not a reason to put task completion or
   benchmark-specific feedback in Relate.
4. For a future SDK design experiment, evaluate explicit query-consumption
   operations and timezone-free datetime/range semantics. Discovery prose alone
   did not establish an SDK improvement. Keep any such SDK changes isolated and
   agree their public contracts before implementing them.

Validation also checks unchanged execution-source hashes, treatment isolation in
actual tool output, per-turn token accounting, graph patch equivalence, archive
byte equality and credential redaction. Analysis reproduces from the archived
patches even when the negative SDK spike Git objects are unavailable. The
retained graph's three Node tests pass. The local explorer retains all **378
historical and current trajectories**, including baseline counterparts.

Final verification: **2,435 archive files** restored byte-for-byte. Browser
results, failed-case filters, full trajectory IDs and same-round baseline
navigation passed; no browser console errors were observed.
