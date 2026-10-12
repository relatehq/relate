# SDK explainer evaluation after the main fixes

Completed 2026-10-12. **Local datetime is the only SDK candidate that passes all
three frozen selection gates.** The snapshot TypeScript read control also
qualifies and remains research infrastructure. Traversal filters passed the
first two rounds but lost accuracy on holdout; the other five SDK candidates did
not qualify in screening. All implementations remain in their isolated
experiment branches. The supported SDK change is
[PR #26: local calendar datetime schemas](https://github.com/relatehq/relate/pull/26),
opened into main.

**336 scored episodes, 4,780 model calls, $2.97 estimated model cost.** There
were no infrastructure failures, missing scored episodes, or requests without
retained usage in these new batches. The earlier TLS-blocked attempts remain
separate historical evidence and are excluded from these comparisons.

## Results

**How to read the scores:** “change 7/12; baseline 10/12” means the suggested
change completed 7 of 12 attempts successfully, while the existing SDK completed
10 of 12 equivalent attempts. Higher is better. These are task-completion scores
from AppWorld's evaluator, not counts of correct API calls. An attempt can make
errors, recover, and still pass.

Each phase runs six tasks twice with the change and twice with its baseline: 12
attempts on each side, 24 in the comparison. The baseline uses the frozen main
fixes without that suggestion. Each suggestion gets fresh baseline runs on the
same tasks with the same model settings and budgets. Model behavior varies
between runs, so baseline scores differ across rows. “Versus” means this paired
comparison; it does not mean before and after within one attempt.

Screening is the initial comparison; confirmation repeats it with fresh runs;
holdout uses the six preselected tasks outside the screening set. “Not advanced”
means the suggestion failed screening and was not run in later phases.

| Candidate                     | Screening                            | Confirmation                        | Holdout                            | Decision                |
| ----------------------------- | ------------------------------------ | ----------------------------------- | ---------------------------------- | ----------------------- |
| Action outcome discovery      | Change **8/12**; baseline **8/12**   | Not advanced                        | Not advanced                       | Fails screening gate    |
| Request diagnostics           | Change **8/12**; baseline **10/12**  | Not advanced                        | Not advanced                       | Fails screening gate    |
| Explicit page/records methods | Change **7/12**; baseline **10/12**  | Not advanced                        | Not advanced                       | Fails screening gate    |
| Local datetime                | Change **8/12**; baseline **8/12**   | Change **10/12**; baseline **7/12** | Change **6/12**; baseline **5/12** | Promote SDK             |
| Relationship predicates       | Change **8/12**; baseline **10/12**  | Not advanced                        | Not advanced                       | Fails screening gate    |
| Traversal filters             | Change **11/12**; baseline **10/12** | Change **10/12**; baseline **9/12** | Change **5/12**; baseline **6/12** | Fails holdout gate      |
| Acquisition coverage          | Change **6/12**; baseline **10/12**  | Not advanced                        | Not advanced                       | Fails screening gate    |
| Snapshot TypeScript control   | Change **10/12**; baseline **8/12**  | Change **11/12**; baseline **7/12** | Change **5/12**; baseline **5/12** | Retain research control |

The fixed gate requires more official passes, or equal passes with at least 10%
fewer mean turns or input tokens and no more than 10% regression in the other
measure. A candidate must qualify independently in all three phases. Failure at
a gate stops promotion; it does not erase the earlier result.

## Local datetime: promote the explicit calendar contract

Across its 36 paired episodes, local datetime scored **24/36 versus 20/36**.
Mean turns were **12.19 versus 13.97** (12.7% fewer); mean input tokens were
**77,938 versus 95,715** (18.6% fewer). These pooled figures summarize the
phases; they did not override any phase gate.

Screening tied at 8/12 with 18.6% fewer turns and 20.7% fewer input tokens.
Fresh confirmation scored 10/12 versus 7/12; holdout scored 6/12 versus 5/12.
The model used calendar-range syntax in the candidate traces: 23 code cells in
screening, 22 in confirmation and 13 in holdout contain both `createdAt` and a
range-operator hint. These are lexical trace hints, not dispatch counts.

The application explicitly changes the authored schema:

```ts
import { localDateTime } from 'relate';

startsAt: localDateTime({ precision: 'second' });

await objects.Appointment.query({
  where: {
    startsAt: {
      gte: '2026-10-01T00:00:00',
      lt: '2026-11-01T00:00:00',
    },
  },
});
```

The helper validates real Gregorian dates, exact seconds or milliseconds and
absence of an offset. Comparisons use calendar tuples. Applications own the
common clock domain; the helper does not infer UTC, resolve DST ambiguity or
establish chronology across timezones. Ordinary strings retain their original
meaning. Adopting this schema changes the graph revision and requires explicit
readoption/reacquisition and recompilation of consumers.

## What did not confirm an SDK improvement

- Action outcome discovery tied on accuracy but used more turns and input
  tokens. Request diagnostics, explicit collection methods, relationship
  predicates and coverage lost screening accuracy against their own controls.
  None was sent through additional selection rounds.
- Explicit collection methods were used in 47 screening code cells containing
  `.page(` or `.records(`. Usage alone did not yield better task completion.
- Coverage added an evidence surface for a trusted acquired scope, but this
  benchmark's fixed acquisition did not establish an agent benefit from it.
- Traversal filters scored 11/12 versus 10/12, then 10/12 versus 9/12, but fell
  to 5/12 versus 6/12 on holdout. Its pooled 26/36 versus 25/36 cannot rescue
  the failed holdout gate. Manual review found no `where` argument on traversal
  calls in screening or confirmation. The seven confirmation cells containing
  both `traverse` and `where` put `where` on a separate top-level query, so the
  lexical audit counter is not evidence that filtered traversals were used. PR
  #25 landed independently during this study; these results are insufficient
  evidence of agent-performance uplift for that feature.

## Did explicit collection methods stop incorrect API calls?

**No. Even the targeted collection-consumption errors remained.** Reviewing the
12 collection-candidate traces and their own 12 paired baseline traces found:

| Observed error turns                                                   | Existing SDK baseline | Explicit page/records change |
| ---------------------------------------------------------------------- | --------------------: | ---------------------------: |
| Confusing a query handle with a page, or losing its iterable interface |                     4 |                           11 |
| Invalid read requests (operators or limits)                            |                     6 |                            9 |
| Invalid action requests                                                |                     6 |                            7 |
| Uncertain action outcomes (not classified as incorrect calls)          |                     0 |                            2 |
| REPL variable redeclarations                                           |                    27 |                           41 |
| Undefined variables                                                    |                     3 |                            0 |
| Iterating an ordinary Promise from an async function                   |                     1 |                            0 |
| **All error turns**                                                    |                **47** |                       **70** |

The targeted collection mistakes occurred in **4/12 baseline episodes and 7/12
candidate episodes**. Of the candidate's 11 collection errors, eight called
`.records()` on an already-awaited page, two tried to iterate that page
directly, and one called `.page()` on it. This recurring pattern was visible in
the code as well as the error messages (illustrative names below):

```ts
// Incorrect: awaiting the thenable query resolves to a page.
const result = await relate.objects.Person.query();
for await (const person of result.records()) console.log(person);
// TypeError: result.records(...) is not a function or its return value
// is not async iterable
```

The explicit methods belong to the query handle, before it has been awaited:

```ts
// Stream records across pages. Do not await query() first.
const query = relate.objects.Person.query();
for await (const person of query.records()) console.log(person);

// Or request just the starting page and read its data array.
const page = await relate.objects.Person.query().page();
for (const person of page.data) console.log(person);
```

The candidate retained the existing thenable query for compatibility, so adding
method names did not remove the ambiguous `await query()` path. The 47 cells
containing `.page(` or `.records(` demonstrate attempted use, not 47 successful
invocations: some cells failed before those calls ran. Other API mistakes also
persisted, including `$eq`, unsupported date-range operators on string
properties, and oversized page limits.

The [sanitized error audit](evidence/explainer-collections-errors.json) lists
run/task/repeat/turn classifications and source hashes. Categories are mutually
exclusive and count observed error turns, not every incorrect call, caught
error, or silent task-logic mistake. The two `uncertain` action outcomes are
deliberately separate from invalid requests. These small screening samples do
not prove the methods cause more errors, but they provide no evidence that this
implementation stopped the intended mistakes. No confirmation or holdout was run
for this arm.

## Snapshot TypeScript control and harness friction

The read control scored **26/36 versus 20/36** across its own paired episodes,
with **10.50 versus 14.97** mean turns and **50,106 versus 111,419** mean input
tokens. It passed screening and confirmation on accuracy and holdout on matching
accuracy with lower turns/input tokens. This is useful evidence that
consumer-interface friction deserves separate attention from graph modeling.

“TS snapshot control” means a comparison condition where the model writes
TypeScript against **arrays of the same normalized records**, instead of using
Relate's consumer query and traversal methods. It asks: with data acquisition
and semantic modeling held constant, how much does the read interface affect the
agent's ability to solve the task?

### How the control works

1. The host acquires the same fixed AppWorld scope and normalizes source IDs and
   properties using the same graph as the baseline. This is the acquired scope,
   not every record available anywhere in AppWorld.
2. Both conditions build the same SDK snapshot internally. The normal condition
   exposes its consumer as `relate` in the persistent Node REPL.
3. The control queries every discovered object internally, follows pagination,
   clones each `{id, data, meta}` record, and exposes arrays as
   `snapshot.records[apiName]`. This happens before the model starts solving.
4. The model filters, joins and aggregates those arrays with ordinary
   TypeScript. `snapshot.describe()` lists scope, object names and actions;
   `snapshot.describeObject(apiName)` supplies properties and relationships,
   with consumer-operation discovery removed. The `relate` global is not
   exposed.
5. Writes still use the same SDK actions and durable provider journal. When an
   action returns a receipt, the wrapper reloads the arrays from the SDK before
   returning that receipt. If the action throws, that reload is not reached.

The materialization in [sdk-repl.mjs](sdk-repl.mjs) is:

```ts
const records = {};
const graph = snapshot.consumer.describe();
const reload = async () => {
  for (const { apiName } of graph.objects) {
    records[apiName] = [];
    for await (const record of snapshot.consumer.objects[apiName].query()) {
      records[apiName].push(structuredClone(record));
    }
  }
};
await reload();
```

Here `snapshot` is the host's internal SDK instance. The agent sees a separate
object containing `records`, `actions`, `describe` and `describeObject`. For
example, these two reads select the same person's outgoing payments (`personId`
stands for a canonical Person ID already discovered by the agent):

```ts
// SDK condition: the query handle streams matching records across pages.
const sdkPayments = [];
for await (const payment of relate.objects.Transaction.query({
  where: { sender: { eq: personId } },
})) {
  sdkPayments.push(payment);
}

// Snapshot control: the full acquired Transaction array is already loaded.
const arrayPayments = snapshot.records.Transaction.filter(
  (payment) => payment.data.sender === personId,
);
```

Joins use the same canonical IDs and graph semantics, but the model implements
them itself instead of invoking a traversal:

```ts
const peopleById = new Map(
  snapshot.records.Person.map((person) => [person.id, person.data]),
);
const outgoing = snapshot.records.Transaction.filter(
  (payment) => payment.data.sender === personId,
).map((payment) => ({
  amount: payment.data.amount,
  recipient: peopleById.get(payment.data.receiver)?.name,
}));
console.log(outgoing);
```

The shared write path is wrapped this way (from the same REPL implementation):

```ts
const action = snapshot.consumer.actions[apiName];
actions[apiName] = Object.assign(
  async (request) => {
    const receipt = await action(request);
    await reload();
    return receipt;
  },
  { describe: () => action.describe() },
);
```

An agent invokes it as
`await snapshot.actions[apiName]({input: {...}, idempotencyKey: "operation-key"})`,
using the discovered action contract. Reloading arrays does not guarantee a new
provider read succeeded: the shared action receipt can still report
`refreshState: "pending"`. Recovery and uncertain-write handling remain the same
as the SDK condition. Because reload replaces the arrays, references the agent
saved to an old array are not automatically updated.

### What the result does and does not establish

This is **not a raw-provider or wholly SDK-free comparison**. Acquisition,
normalization, canonical identity, semantic descriptions, SDK-backed actions and
provider-write recovery remain shared. Original provider APIs and credentials
are unavailable to the control agent. The changed surface is reading and joining
preloaded data, together with the instructions/discovery needed for that
surface. It does not measure the value of graph modeling against unmodeled raw
APIs.

Eager materialization is recorded as setup work, including setup fetches. Arrays
avoid model-facing query pagination and request-shape mistakes, but move that
work to the host and require memory for the acquired scope. Lower model input
tokens are not proof that total host work is cheaper or that this approach
scales to large/live datasets. The result supports further read-interface
experiments; it does not establish that replacing the SDK with arrays is a
product improvement.

Across screening, 560 of 819 error turns (68.4%) were variable redeclarations.
The persistent REPL binding behavior was held constant in both Node interfaces.
It remains a substantial harness limitation. A future notebook-scoping study
must change it equally in both arms and use fresh comparisons; these runs were
not repaired or tuned after observing failures.

## Controls, provenance and limitations

- The evaluated SDK baseline is **main `cd1a789`**, including PR #23 compiled
  consumer descriptions/complete canonical-ID results and PR #24 stable action
  operation identity. Every evaluated SDK arm contains that baseline; the two
  controls have exactly its SDK tree. This study measures incremental candidates
  on that baseline, not the causal effect of the landed fixes versus old main.
- All responses identify `gpt-5.4-nano-2026-03-17`, requested as nano/low. Each
  episode allows 28 turns, 4,096 output tokens per request, 14,000 generated
  tokens total and 14,000 output characters. The task state uses seed 100.
- Screening ran 192 episodes; confirmation and holdout ran 72 each. After the
  first five completed episodes, execution moved to three concurrent matched
  pairs. No episode was restarted or discarded. Each pair kept its prescribed
  ordering, and budget reservations shared the $5 batch ceiling. No episode
  reached a cost stop. Wall-clock latency is not a promotion metric.
- The holdout IDs were fixed before viewing screening outcomes: `82e2fac_2`,
  `82e2fac_3`, `d0b1f43_2`, `d0b1f43_3`, `e7a10f8_1`, `e7a10f8_2`. Only
  train/dev tasks were used. They are outside this study's screening set, not
  guaranteed unseen by every historical study. They cover read-task siblings; no
  write-family siblings remained outside screening. Generalization to unseen
  write instances is therefore untested.
- Twelve episodes per side per phase, stochastic controls and selection among
  eight comparisons limit confidence. These are development diagnostics, not
  broad benchmark or statistical-significance claims. In particular, absolute
  holdout success is low even for the qualifying arms.
- Main advanced to `084e6b9` (PR #25) during execution. The experiment branches
  remain frozen. The promoted datetime implementation is integrated separately
  onto that newer main, with an additional memory/Postgres test for related
  records filtered by a local date range. The 336 scores belong to the frozen
  study builds, not a new model evaluation of the combined implementation.

## Evidence and reproduction

[Screening](evidence/explainer-screen.json),
[confirmation](evidence/explainer-confirm.json), and
[holdout](evidence/explainer-holdout.json) contain sanitized per-episode results
and paired metrics. Their corresponding `*-audit.json` files verify all saved
scores against AppWorld's official evaluator output, source-file hashes,
model/settings, request accounting and lexical feature-use hints.

The prepared branch/build/source identities remain in
[evidence/explainer-readiness.json](evidence/explainer-readiness.json). Original
prompts, responses, code, provider-write journals, world outputs and ledgers
remain in the ignored `.local/` directories of the research and SDK worktrees.
Raw protected task data and credentials are not published.

```sh
# Read-only recomputation from retained local artifacts:
dev/research/appworld/.venv/bin/python \
  dev/research/appworld/explainer_compare.py explainer-main-screen-20261012

dev/research/appworld/.venv/bin/python \
  dev/research/appworld/explainer_audit.py explainer-main-screen-20261012
```

Substitute `confirm` or `holdout` for the other two batches. Selection tests
cover missing/incomplete pairs, accuracy regression and the efficiency boundary.
The bounded coordinator tests verify resume without replay, pair ordering and
budget reservations. The research Python suite passes 40 tests. The seven frozen
SDK candidates passed full `pnpm check` before evaluation, and all 54 offline
task/arm preflights passed. The promotion build passes full `pnpm check` (992
tests) and `pnpm docs:check`. PR 14 on refreshed main passes full `pnpm check`
(975 tests), all 40 Python research tests and 13 Node tests. PR 19 on refreshed
main passes full `pnpm check` (981 tests), including the scripted discovery
probe.
