# Explainer follow-up: implemented and ready for online evaluation

All six proposal areas are implemented as isolated local experiments.
Relationship discovery and traversal filtering are separate arms, giving seven
SDK candidates. Each has its own branch and checkout. No candidate has been
promoted, pushed, or opened as an SDK PR. Any qualifying PR must target
**main**.

## Branches and contracts

| Arm                  | Local branch                       | SDK commit | What changes                                                                                                                                                                                 |
| -------------------- | ---------------------------------- | ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Unchanged control    | `test/explainer-sdk-experiments`   | `643bf10`  | SDK tree exactly matches main `cd1a789`, including PRs 23 and 24.                                                                                                                            |
| Action outcomes      | `test/explainer-action-outcomes`   | `a35991b`  | Authorized `action.describe().result` gives receipt state/output/error paths and a consumption example.                                                                                      |
| Request errors       | `test/explainer-error-diagnostics` | `374a73d`  | Authorized action-input issues; accepted read operators; bounded JSON and messages without supplied values.                                                                                  |
| Collections          | `test/explainer-collections`       | `cece92b`  | `await query.page()` and `for await (const record of query.records())`, sharing the existing lazy loader.                                                                                    |
| Local datetime       | `test/explainer-local-datetime`    | `abc6686`  | Explicit second/millisecond calendar schemas, validation and range predicates with memory/Postgres parity.                                                                                   |
| Relationships        | `test/explainer-relationships`     | `882a4eb`  | Direction and actual direct/junction reference predicates in authorized traversal discovery.                                                                                                 |
| Traversal filters    | `test/explainer-traversal-filters` | `108cf9f`  | Target predicates on to-many traversals, adapted from `e076b4c` to the shared consumer facade.                                                                                               |
| Acquisition coverage | `test/explainer-coverage`          | `9aa017c`  | Host evidence for a named source scope, independently of graph exhaustion and field completeness. Authorization checked before and after each query page.                                    |
| Array control        | `test/explainer-snapshot-control`  | `643bf10`  | Same normalized records as arrays; plain TypeScript reads/joins. Shared SDK-backed action adapter remains identical. This is a read-API control, not a wholly SDK-free write implementation. |

The primary checkout's unfinished traversal work was not copied into the filter
arm. PRs 23 and 24 are merged into main and included in every arm. The existing
research write journal and its failure/restart tests are held constant; receipt
discovery cannot create exactly-once provider effects. Declared domain errors
remain application-owned; transport failures and uncertain effects are not
converted into business failures.

All authored SDK changes, tests, package/public documentation and migration
notes are in their candidate branches. The coordinator, snapshot-control
environment, and reproducible graph variants are research-only changes on PR
14's branch. There are no SDK package edits on that research branch.

## Main refresh (2026-10-12)

Merged main `cd1a789` into PR 14 and every experiment checkout. PR 23 adds
`compile(graph).consumer`, model revision binding, registry-key receipt lookup
and complete object results with canonical IDs. PR 24 supplies stable
`ActionContext.operationId` for the existing AppWorld write journal. These are
common baseline behavior, not candidate improvements. All seven candidates
remain distinct; none is superseded by these changes.

The baseline and snapshot-control SDK trees exactly match main. Preparation
requires this identity and main ancestry, and old prepared manifests are
rejected after the baseline changes. The original TLS attempts and pre-refresh
evidence remain historical; resumed runs require fresh controls and new batch
names.

## Offline validation

Full `pnpm check` passed independently on all seven SDK candidates, including
formatting, lint, typechecking, boundary checks, unit/Postgres tests and
installed package smoke checks:

| Candidate            | Tests passed |
| -------------------- | -----------: |
| Action outcomes      |          950 |
| Request errors       |          954 |
| Collections          |          950 |
| Local datetime       |          964 |
| Relationships        |          951 |
| Traversal filters    |          965 |
| Acquisition coverage |          955 |

These counts include repeated baseline tests, not distinct tests across the
study. The ignored research harness is outside SDK lint scope during those
checks; `explainer_experiments.py check` temporarily relocates it and restores
it in a `finally` block. It does not rewrite frozen evidence.

Research tests: **35 Python and 13 Node tests pass**. The offline preflight runs
all **nine arms across all six screening tasks**, exercising real acquisition,
identity normalization, SDK construction and each named public capability. These
are 54 deterministic task/arm preflights, **not 54 agent task completions**. No
model calls or new paid evaluation were made during implementation.

[Sanitized readiness evidence](evidence/explainer-readiness.json) records SDK
commits, build/source hashes, full-check counts and offline preflight results.
Complete check logs and prepared patches stay under `.local/`.

## Run when connectivity is stable

From this research checkout, refresh and verify the prepared arms without any
model calls:

```sh
dev/research/appworld/.venv/bin/python \
  dev/research/appworld/explainer_experiments.py prepare

dev/research/appworld/.venv/bin/python \
  dev/research/appworld/explainer_experiments.py preflight
```

`prepare` rejects dirty SDK checkouts, rebuilds their real packages and freezes
commit, SDK patch, build and harness hashes. It copies only ignored research
support into each SDK checkout; the two graph variants are applied explicitly
and tested for patch drift. The shared runner, prompts, REPL, source acquisition
and write-recovery files have identical hashes across arms. Only datetime schema
adoption and acquisition coverage change the graph source.

Start the online screening batch explicitly:

```sh
dev/research/appworld/.venv/bin/python \
  dev/research/appworld/explainer_experiments.py run \
  --batch explainer-screen-v1 --round screen \
  --credentials /path/to/authorized/provider.env --max-cost-usd 5
```

The default is six tasks, two repeats, and a fresh paired control per candidate:
192 planned episodes across eight candidates/controls, subject to the batch cost
cap. Candidate order rotates; control/candidate order alternates. Task state,
model (nano low), prompts for SDK arms, 28-turn limit and token budgets stay
fixed. Every run name is unique. A started-attempt record is written before
execution. Partial episodes, unknown scores and known spend remain in the
ledger; an infrastructure failure stops the batch without retries or a model
switch. Provider usage absent from a failed response remains billing
uncertainty.

To screen or confirm one candidate, use `--arms collections` (the paired
baseline is automatic), a new `--batch`, and `--round screen` or `confirm`. For
holdout, use `--round holdout --tasks ...` with previously unselected train/dev
instances; the coordinator rejects screening IDs and the runner rejects test
splits. Freeze holdout selection before examining outcomes. Do not use
test-normal or test-challenge. Never reuse an existing batch/run directory.

To rerun SDK checks safely with local research support present:

```sh
dev/research/appworld/.venv/bin/python \
  dev/research/appworld/explainer_experiments.py check \
  --arms actions errors collections datetime relationships filters coverage
```

Do not run prepare/check while a model batch is executing. `run` verifies frozen
commits/builds/sources before each episode. A mismatch stops it. Results and the
attempt ledger are under `.local/explainer-batches/<batch>/`; each checkout also
retains the standard `sdk_runner.py` config, frozen source and trajectory files.
The new snapshot control reports setup time and `setup_snapshot_fetches`
separately from agent-turn fetches. Its eager array materialization is not free
host work, and it must not be presented as a raw-API comparison.

## Promotion and historical attempts

The [frozen plan](EXPLAINER-PLAN.md) still governs promotion: end-to-end task
results, fresh confirmation controls and holdout evidence, not just fewer error
messages or passing unit tests. No improvement in agent performance is claimed.
The seven SDK implementations are independent hypotheses, not a combined patch.

The five earlier TLS-blocked attempts are preserved in
[evidence/explainer-attempts.json](evidence/explainer-attempts.json). Only the
first received one model turn; none had a scored result. Known recorded model
cost was $0.000192, with unknown billing for responses that never arrived. These
attempts are historical context, not fresh controls for the prepared harness. No
original traces or encrypted archives were overwritten.
