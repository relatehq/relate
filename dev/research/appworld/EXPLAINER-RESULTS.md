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

Every cell is **candidate successes versus its own fresh paired control**. Each
phase has 12 episodes per side: six tasks, two repeats. Control variation is
visible; there is no single shared control score to substitute across arms.

| Candidate                     | Screening      | Confirmation  | Holdout      | Decision                |
| ----------------------------- | -------------- | ------------- | ------------ | ----------------------- |
| Action outcome discovery      | 8/12 vs 8/12   | Not advanced  | Not advanced | Fails screening gate    |
| Request diagnostics           | 8/12 vs 10/12  | Not advanced  | Not advanced | Fails screening gate    |
| Explicit page/records methods | 7/12 vs 10/12  | Not advanced  | Not advanced | Fails screening gate    |
| Local datetime                | 8/12 vs 8/12   | 10/12 vs 7/12 | 6/12 vs 5/12 | Promote SDK             |
| Relationship predicates       | 8/12 vs 10/12  | Not advanced  | Not advanced | Fails screening gate    |
| Traversal filters             | 11/12 vs 10/12 | 10/12 vs 9/12 | 5/12 vs 6/12 | Fails holdout gate      |
| Acquisition coverage          | 6/12 vs 10/12  | Not advanced  | Not advanced | Fails screening gate    |
| Snapshot TypeScript control   | 10/12 vs 8/12  | 11/12 vs 7/12 | 5/12 vs 5/12 | Retain research control |

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

## Snapshot TypeScript control and harness friction

The read control scored **26/36 versus 20/36** across its own paired episodes,
with **10.50 versus 14.97** mean turns and **50,106 versus 111,419** mean input
tokens. It passed screening and confirmation on accuracy and holdout on matching
accuracy with lower turns/input tokens. This is useful evidence that
consumer-interface friction deserves separate attention from graph modeling.

This control receives the same normalized acquired records and semantic
information as arrays, with plain TypeScript reads/joins. It retains the same
SDK-backed action adapter, source-write journal and recovery behavior. It is
**not a raw-provider or wholly SDK-free comparison**. Its eager materialization
is recorded as setup work, including setup fetches; input-token efficiency is
not a claim that all host work is free.

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
task/arm preflights passed. See the promotion PR for checks on the newer main
integration.
