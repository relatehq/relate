# Main queries and expanded AppWorld subset

**No accuracy improvement on the original subset:** SDK success falls from 4/6
to 2/6, while mean turns rise from 15.7 to 18.2 and mean input tokens rise from
113,736 to 126,119. The expanded six-task run ties raw TS at 6/12; both score
5/6 reads and 1/6 writes. SDK uses fewer turns overall but more input and output
tokens. Raw Python scores 4/12. Sampling varies in the unchanged controls too,
so these small runs do not establish a causal regression.

Main `2cf7f92` is merged in `fea6069`, including scalar query predicates and
timestamp support (`406f388`, PR21), plus the shared typed consumer (PR22).
Graph property descriptions from `334db11` are retained. Experiment protocol is
frozen at `9d236d2` in [QUERIES-PLAN.md](QUERIES-PLAN.md).

No solving hints, query examples or reminders were added to the prompts. The
agent discovers the current SDK contract. REPL behavior, source acquisition,
write actions, completion and scoring are unchanged. Static notes remain
retired.

## Full expanded subset: six tasks, two repeats per method

| Method | Success | Writes | Reads | Completed | Mean turns | Mean seconds | Mean input tokens | Mean output tokens | USD     |
| ------ | ------- | ------ | ----- | --------- | ---------- | ------------ | ----------------- | ------------------ | ------- |
| raw    | 4/12    | 2/6    | 2/6   | 12/12     | 18.8       | 27.0         | 98,363            | 2,046              | $0.1079 |
| raw_ts | 6/12    | 1/6    | 5/6   | 11/12     | 18.3       | 28.6         | 88,608            | 2,351              | $0.1120 |
| sdk    | 6/12    | 1/6    | 5/6   | 12/12     | 15.8       | 27.3         | 104,764           | 2,519              | $0.1091 |

### Scores by task

| Task      | Raw Python | Raw TS | Relate SDK |
| --------- | ---------- | ------ | ---------- |
| afc0fce_1 | 1/2        | 0/2    | 1/2        |
| afc0fce_2 | 0/2        | 0/2    | 0/2        |
| d0b1f43_1 | 0/2        | 2/2    | 1/2        |
| afc0fce_3 | 1/2        | 1/2    | 0/2        |
| e7a10f8_3 | 1/2        | 2/2    | 2/2        |
| 82e2fac_1 | 1/2        | 1/2    | 2/2        |

## Original three-task subset: like-for-like before → after

The new tasks are excluded from this table. Fresh trajectories are not matched
prefixes; world seed is fixed but provider sampling and graph IDs vary.

| Method | Success   | Writes    | Reads     | Mean turns  | Mean input tokens | Mean output tokens | Mean seconds |
| ------ | --------- | --------- | --------- | ----------- | ----------------- | ------------------ | ------------ |
| raw    | 4/6 → 1/6 | 2/4 → 1/4 | 2/2 → 0/2 | 17.8 → 18.3 | 91,600 → 98,353   | 1,796 → 1,959      | 26.8 → 26.7  |
| raw_ts | 1/6 → 2/6 | 0/4 → 0/4 | 1/2 → 2/2 | 21.8 → 20.5 | 124,512 → 105,233 | 2,862 → 2,773      | 38.2 → 33.5  |
| sdk    | 4/6 → 2/6 | 2/4 → 1/4 | 2/2 → 1/2 | 15.7 → 18.2 | 113,736 → 126,119 | 3,298 → 3,044      | 34.2 → 32.3  |

## Added tasks

| Task ID   | Paraphrased task                                                | Selection rationale                                                       |
| --------- | --------------------------------------------------------------- | ------------------------------------------------------------------------- |
| afc0fce_3 | Like and comment on incoming roommate payments in a date window | New variant covered by existing write actions and contact graph           |
| e7a10f8_3 | Duration of longest playlist                                    | New instance covered by playlist membership, songs and duration           |
| 82e2fac_1 | Most-liked song across playlists                                | Reintroduced from the older read study; covered by public song popularity |

No solutions or evaluator internals were used to select tasks. These six
training instances span four families; the three writes are variants of one
family. The task additions do not establish broad new-domain coverage.

| Method | Added-subset success | Added write | Added reads |
| ------ | -------------------- | ----------- | ----------- |
| raw    | 3/6                  | 1/2         | 2/4         |
| raw_ts | 4/6                  | 1/2         | 3/4         |
| sdk    | 4/6                  | 0/2         | 4/4         |

## Successful cases in both old and new original subsets

These cases avoid changing the set of successful tasks when comparing
efficiency. They still use fresh sampling, so changes are not isolated causal
estimates.

| Case: task / method / repeat | Turns   | Input tokens      | Output tokens |
| ---------------------------- | ------- | ----------------- | ------------- |
| `afc0fce_1/raw/0`            | 23 → 22 | 129,002 → 113,717 | 2,263 → 2,070 |
| `afc0fce_1/sdk/1`            | 22 → 16 | 180,308 → 95,997  | 5,959 → 2,658 |
| `d0b1f43_1/raw_ts/0`         | 19 → 16 | 80,428 → 66,383   | 1,635 → 1,636 |
| `d0b1f43_1/sdk/0`            | 16 → 24 | 77,440 → 184,863  | 2,171 → 3,429 |

The two SDK cases that succeed in both runs move from a mean **19 → 20 turns**,
**128,874 → 140,430 input tokens**, and **4,065 → 3,044 output tokens**. One
case improves substantially; the other gets worse. Output tokens fall, but there
is no matched-success improvement in mean turns or input tokens.

## What improved queries mean for this graph

The current SDK supports scalar equality and operator objects. `eq` and `in`
apply to scalar properties; `gt`, `gte`, `lt`, `lte` apply to numbers and typed
timestamps. The operation contract is exposed by discovery. These illustrations
are not prompt content or benchmark answers:

```typescript
relate.objects.Transaction.query({
  where: { sender: { in: personIds }, amount: { gte: minimumAmount } },
});
```

AppWorld datetimes are deliberately timezone-free. The research model preserves
createdAt and releaseDate as strings, and does not label them as
timezone-qualified instants. Therefore **timestamp range support is not
activated for these fields**. Agents must still filter them client-side. No
unapproved timezone conversion, new date property, SDK change or harness repair
was added to make the test pass.

The recorded Transaction descriptions expose createdAt as a string with
`filterOperators: ['eq', 'in']`. The first-repeat write and payment-read agents
received that complete description before trying unsupported ranges; the
relevant contract was not lost to output truncation.

The first SDK coworker failure (`afc0fce_1__sdk__0`) illustrates the boundary:
it successfully used `eq` for Person.email and Transaction.receiver, attempted
`gte/lte` on createdAt and received an unsupported-operator ReadError. It
recovered by scanning incoming transactions, but omitted the coworker label and
changed an over-broad set. Completion passed; exact write-target checks failed.
Better predicates did not automatically make the agent apply every task
constraint.

## Concrete trajectories

- `afc0fce_1__sdk__1` passes in 16 turns. After an invalid `$eq` guess and two
  redeclaration errors, the agent queries owner-scoped ContactRelationship
  records with exact `kind`, filters transaction direction and dates, discovers
  both actions, mutates the selected set and completes without an answer. The
  successful selection uses ordinary equality and client-side membership; it is
  not evidence that the new range operators caused the pass.
- `afc0fce_2__sdk__0` describes ContactRelationship but queries only `owner`. It
  calls the resulting set “friends” without applying `kind`. Its `sender.in`
  filter works after it removes unsupported date ranges, but faithfully narrows
  to the wrong set of people. Both source actions execute; exact target checks
  fail. Discovering the relationship is different from using its full semantics.
- `d0b1f43_1__sdk__0` passes in 24 turns. It obtains exact roommate labels, uses
  `receiver.in`, and recovers from unsupported date ranges by filtering dates
  locally. Five redeclaration errors and several progress-only cells inflate the
  trajectory. New predicates work, but do not remove REPL friction.
- `e7a10f8_3__sdk__0` passes in 8 turns: graph discovery → Playlist and Song
  descriptions → per-playlist `traverse.songs` → sum `duration` in seconds →
  convert to rounded minutes → completion. The units description is available
  and used consistently. This case has no matched preceding-run baseline, so we
  cannot attribute the success to that description change.
- `82e2fac_1__sdk__0` passes in 7 turns by iterating the acquired Song
  collection, finding the maximum `likeCount`, then submitting the title. The
  graph contains songs from the playlist library by construction; the raw arm
  must enumerate source playlists and pages itself. That acquisition and
  modeling difference remains part of the comparison.

- `d0b1f43_1__sdk__1` fails in 12 turns. It prints only the first ten
  ContactRelationship records, copies two roommate IDs from that sample, and
  omits the third roommate. Its recovered `eq`/`in` query executes correctly,
  but the sum is incomplete. This is selection from a displayed sample rather
  than a complete exact-kind query; the failure is not a rejected predicate.

- `afc0fce_3__sdk__1` selects the correct roommate target set and successfully
  performs both writes at turn 18. It then reads `.message` on the action result
  envelope, obtains undefined, and reruns a comment with a new idempotency key
  at turn 20 while trying to inspect results. The extra comment succeeds; the
  subsequent duplicate-like call yields `ActionError: internal`. Turn 22
  confirms one transaction has two comments. The sole evaluator failure is the
  duplicate comment. This is a concrete action-result inspection/retry problem,
  distinct from the selection failures; same-key replay was not used.

These are observations from retained traces, not proposed harness changes.

## SDK query-use diagnostics

The turn lists below are code-text indicators, not successful-call counts. Read
each trajectory's output to distinguish executed queries from rejected requests,
redeclaration failures and other uses of similarly named properties.

| SDK case            | Official | Operator-code turns                 | Contact-surface turns | ReadError turns | Redeclaration errors |
| ------------------- | -------- | ----------------------------------- | --------------------- | --------------- | -------------------- |
| `82e2fac_1__sdk__0` | pass     | []                                  | []                    | []              | 0                    |
| `82e2fac_1__sdk__1` | pass     | []                                  | []                    | []              | 0                    |
| `afc0fce_1__sdk__0` | fail     | [5, 6, 7, 8, 9, 10, 11, 14, 16, 17] | []                    | [8]             | 5                    |
| `afc0fce_1__sdk__1` | pass     | [7]                                 | [11, 12, 13]          | [7]             | 2                    |
| `afc0fce_2__sdk__0` | fail     | [9, 10, 11, 12, 13, 15, 16, 18]     | [5, 8]                | [9]             | 4                    |
| `afc0fce_2__sdk__1` | fail     | [7, 8, 9, 11, 12]                   | []                    | [8]             | 5                    |
| `afc0fce_3__sdk__0` | fail     | [9, 10, 17]                         | []                    | [10]            | 9                    |
| `afc0fce_3__sdk__1` | fail     | [3]                                 | [8, 9]                | [3]             | 7                    |
| `d0b1f43_1__sdk__0` | pass     | [17, 18, 19, 20, 21]                | [4, 13, 14, 16]       | [19]            | 5                    |
| `d0b1f43_1__sdk__1` | fail     | [8, 9, 10, 11]                      | [5, 7]                | [9]             | 2                    |
| `e7a10f8_3__sdk__0` | pass     | []                                  | []                    | []              | 0                    |
| `e7a10f8_3__sdk__1` | pass     | []                                  | []                    | []              | 1                    |

## Time, cost and limits

The 36 episodes total **16.6 minutes** of recorded episode wall time, **635
turns**, and **$0.3290** estimated model cost. Time includes setup/acquisition
but excludes report generation. Input tokens include cached and repeated
context; cost is the frozen runner estimate, not a billing statement.

All methods retain nano low reasoning, 28 turns, 4,096 output tokens/request,
14,000 generated tokens/episode, 14,000 visible characters/turn, 60-second
execution timeout, world seed 100 and a $2 run cap. There is no provider seed,
per-turn completion feedback, automatic retry or model switch. Every attempted
episode is retained. This is research on a small training subset, not a
leaderboard score. Main SDK changes and graph description changes are a combined
intervention.

## Next tests suggested by these observations

These are proposals, not changes made in this run.

1. Repeat the fixed six-task protocol more times before interpreting the
   movement as an SDK regression. Keep the original subset visible and compare
   raw TS against SDK with paired task instances.
2. Inspect action-receipt discoverability: the public return is
   `{ invocationId, state: 'succeeded', output: { message, ... } }`. The
   roommate trajectory reads `receipt.message` rather than
   `receipt.output.message`, then changes its key and duplicates a mutation.
   Test whether a clearer discovered receipt contract prevents that behavior;
   agree any SDK change separately. The research action's `errors: {}` also
   means the source duplicate-like rejection currently surfaces as an internal
   action error, not a declared domain outcome.
3. Agree the temporal model before testing timestamp-range benefits. AppWorld
   local dates are not UTC instants. Simply assigning `Z` would test an invented
   conversion. A deliberate local-datetime contract or justified adapter
   representation needs its own isolated experiment.
4. If changing the harness later, separately test REPL variable persistence
   ergonomics in both Node arms. There are 40 SDK redeclaration-error turns in
   this run. No rewriting, automatic retry or reminder was introduced here.

## Validation and evidence

Package rebuild, 18 Python harness tests, 11 Node tests and real AppWorld
source-write/readback/receipt-replay smoke passed before execution. The
comparison checks all 54 baseline/candidate cases, exact initial messages for
matched tasks, unchanged condition-specific prompts across runs, source hashes,
matching acquisition call counts and token/cost/request accounting. Package
sources match merged main. Protected traces are archived using AppWorld's bundle
format and round-tripped; public reports and the local viewer are checked for
credential redaction.

Repository-wide check outcome: `pnpm check` passed: 90 test files / 945 tests,
including Postgres integration, plus installed-package checks. The first attempt
stopped at existing research blank-line lint errors; those were fixed after
model execution. The three affected JavaScript files were verified to differ
only in whitespace, and the full check was then rerun successfully. Frozen run
sources retain the pre-formatting code.

The viewer retains the previous reports and adds the new run first, with task,
method and success filters, per-turn tokens/time, full trajectory IDs and links
to matching old cases for the original subset.

Public evidence: [measurements](evidence/queries.json),
[comparison](evidence/queries-comparison.json),
[validation](evidence/queries-validation.json).

Archive verification: 1,745 files restored byte-for-byte. Browser verification
confirmed current totals, six failed SDK cases, full IDs and round-trip
matched-case navigation without console errors.

## Every new trajectory

| ID suffix              | Subset   | Official | Turns | Seconds | Input tokens | Output tokens | USD     |
| ---------------------- | -------- | -------- | ----- | ------- | ------------ | ------------- | ------- |
| `82e2fac_1__raw__0`    | added    | pass     | 17    | 20.4    | 80,357       | 1,264         | $0.0086 |
| `82e2fac_1__raw__1`    | added    | fail     | 17    | 23.9    | 93,639       | 2,127         | $0.0082 |
| `82e2fac_1__raw_ts__0` | added    | fail     | 18    | 21.6    | 76,156       | 1,519         | $0.0078 |
| `82e2fac_1__raw_ts__1` | added    | pass     | 13    | 17.1    | 46,234       | 1,230         | $0.0054 |
| `82e2fac_1__sdk__0`    | added    | pass     | 7     | 8.3     | 23,884       | 514           | $0.0027 |
| `82e2fac_1__sdk__1`    | added    | pass     | 11    | 13.4    | 40,715       | 745           | $0.0037 |
| `afc0fce_1__raw__0`    | original | pass     | 22    | 34.2    | 113,717      | 2,070         | $0.0095 |
| `afc0fce_1__raw__1`    | original | fail     | 15    | 20.7    | 73,737       | 1,654         | $0.0071 |
| `afc0fce_1__raw_ts__0` | original | fail     | 28    | 38.4    | 128,375      | 3,126         | $0.0132 |
| `afc0fce_1__raw_ts__1` | original | fail     | 16    | 32.2    | 90,102       | 3,122         | $0.0106 |
| `afc0fce_1__sdk__0`    | original | fail     | 18    | 35.0    | 131,144      | 3,677         | $0.0123 |
| `afc0fce_1__sdk__1`    | original | pass     | 16    | 27.9    | 95,997       | 2,658         | $0.0091 |
| `afc0fce_2__raw__0`    | original | fail     | 18    | 26.4    | 114,560      | 1,932         | $0.0093 |
| `afc0fce_2__raw__1`    | original | fail     | 25    | 36.1    | 158,802      | 2,885         | $0.0128 |
| `afc0fce_2__raw_ts__0` | original | fail     | 27    | 52.0    | 156,457      | 3,786         | $0.0160 |
| `afc0fce_2__raw_ts__1` | original | fail     | 10    | 17.3    | 32,942       | 1,640         | $0.0053 |
| `afc0fce_2__sdk__0`    | original | fail     | 19    | 36.1    | 152,822      | 3,451         | $0.0123 |
| `afc0fce_2__sdk__1`    | original | fail     | 20    | 34.0    | 124,981      | 2,860         | $0.0111 |
| `afc0fce_3__raw__0`    | added    | fail     | 25    | 35.8    | 160,995      | 2,499         | $0.0116 |
| `afc0fce_3__raw__1`    | added    | pass     | 26    | 37.8    | 134,620      | 2,883         | $0.0124 |
| `afc0fce_3__raw_ts__0` | added    | fail     | 19    | 32.4    | 92,991       | 2,882         | $0.0101 |
| `afc0fce_3__raw_ts__1` | added    | pass     | 16    | 22.3    | 69,951       | 1,887         | $0.0074 |
| `afc0fce_3__sdk__0`    | added    | fail     | 25    | 45.3    | 186,489      | 4,530         | $0.0149 |
| `afc0fce_3__sdk__1`    | added    | fail     | 23    | 44.0    | 195,904      | 4,350         | $0.0146 |
| `d0b1f43_1__raw__0`    | original | fail     | 14    | 18.8    | 60,292       | 1,375         | $0.0067 |
| `d0b1f43_1__raw__1`    | original | fail     | 16    | 24.3    | 69,008       | 1,840         | $0.0075 |
| `d0b1f43_1__raw_ts__0` | original | pass     | 16    | 21.5    | 66,383       | 1,636         | $0.0076 |
| `d0b1f43_1__raw_ts__1` | original | pass     | 26    | 39.6    | 157,137      | 3,328         | $0.0137 |
| `d0b1f43_1__sdk__0`    | original | pass     | 24    | 38.3    | 184,863      | 3,429         | $0.0130 |
| `d0b1f43_1__sdk__1`    | original | fail     | 12    | 22.3    | 66,907       | 2,190         | $0.0086 |
| `e7a10f8_3__raw__0`    | added    | pass     | 17    | 26.5    | 73,870       | 2,367         | $0.0084 |
| `e7a10f8_3__raw__1`    | added    | fail     | 13    | 19.7    | 46,758       | 1,653         | $0.0059 |
| `e7a10f8_3__raw_ts__0` | added    | pass     | 12    | 17.6    | 47,812       | 1,384         | $0.0054 |
| `e7a10f8_3__raw_ts__1` | added    | pass     | 19    | 31.5    | 98,756       | 2,674         | $0.0096 |
| `e7a10f8_3__sdk__0`    | added    | pass     | 8     | 9.4     | 25,566       | 646           | $0.0031 |
| `e7a10f8_3__sdk__1`    | added    | pass     | 7     | 13.1    | 27,896       | 1,177         | $0.0037 |
