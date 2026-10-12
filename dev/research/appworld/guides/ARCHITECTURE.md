# Architecture and maintenance boundaries

All paths below are relative to `dev/research/appworld`. This directory is a
research application using the public Relate SDK. Core package tests must not
depend on it.

## Execution and ownership

```text
two_model_eval.py                    explainer_experiments.py / explainer_batch.py
(single-pass task/model matrix)      (historical candidate/control experiments)
             |                                      |
             +------------> sdk_runner.py <----------+
                              |
          +-------------------+----------------------+
          |                   |                      |
   model_provider.py    AppWorld Python host     NodeRepl host bridge
   prompts.py           raw / static cells            |
   harness_protocol.py  public API acquisition    sdk-repl.mjs
                        durable source writes    permission-constrained Node
                                                      |
                                      +---------------+---------------+
                                      |               |               |
                                    raw_ts           sdk         snapshot_ts
                                    API proxy        consumer    plain arrays
                                                      |          SDK actions
                                                      +-------+-------+
                                                              |
                                                        sdk-graph.mjs
                                                        music-model.mjs
                                                        public Relate SDK
```

The host authenticates the same three apps for every condition. `raw` and
`static` execute in AppWorld's persistent Python interpreter. `raw_ts` gets an
async proxy preserving public API names, named arguments, responses, and manual
pagination. It receives no acquired graph. `sdk` and `snapshot_ts` receive the
same fixed music/payments acquisition, without original APIs or source tokens.

The Node worker transpiles TypeScript without typechecking. `NodeRepl` handles
newline-delimited events, enforces a 60-second cell deadline, and dispatches
host operations. Only `raw_ts` can emit generic `api` events. The other Node
conditions share allowlisted `source-write` events. `completeTask` is a host
benchmark capability, not a Relate action. Node's filesystem/network permissions
constrain the worker; the host owns provider credentials and journal files.

`snapshot_ts` materializes records and schema descriptions as ordinary arrays,
but its actions still use the SDK adapter. It is not an entirely SDK-free
control. The legacy `static` condition remains executable for historical work;
the current batch scheduler selects `raw`, `raw_ts`, `sdk`, and `snapshot_ts`.

## Module map

| Modules                                                                     | Responsibility                                                                                           |
| --------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `sdk_runner.py`                                                             | Episode lifecycle, budgets, request journal, execution, official scoring, and host/Node bridge           |
| `model_provider.py`                                                         | Provider wire protocols, replay, retained usage, and frozen cost estimates; no automatic retries         |
| `prompts.py`, `harness_protocol.py`                                         | Agent instructions, shared code-cell schema, and historical static-note treatment                        |
| `task_catalog.py`                                                           | Explicit baseline/additional task families and train/dev inventory                                       |
| `acquire.py`                                                                | Public pagination, payment normalization, contact groups, and derived group/payment memberships          |
| `music_acquire.py`                                                          | Public catalog, personal memberships/state, recommendations, and player acquisition                      |
| `sdk-graph.mjs`, `music-model.mjs`                                          | Graph definitions, canonical references, snapshot sources, action implementations, and readback adoption |
| `source_writes.py`, `music_writes.py`                                       | Episode/account-local SQLite outcome journals and allowlisted Venmo/Spotify operations                   |
| `sdk-repl.mjs`                                                              | Persistent Node execution, original-API proxy, SDK consumer, and snapshot-array interface                |
| `retained_usage.py`                                                         | Usage across returned responses and incomplete attempts; historical ergonomics arm eligibility           |
| `two_model_eval.py`, `audit_two_model.py`                                   | Single-pass schedule and budget reservations; audit schedule, scores, usage, and source identity         |
| `results_explorer.py`, `results_explorer.html`, `archive_batch.py`          | Complete batch export, request reconstruction, and byte-verified encrypted retention                     |
| `runner.py`, `graph.mjs`, `probe_adapter.py`, `measure.mjs`, `summarize.py` | Original Ollama `research()` experiment and diagnostics                                                  |
| `*_compare.py`, `validate_*.py`, `sdk_summarize.py`, `write_audit.py`       | Study-specific reporting and validation, with frozen run names and denominators                          |
| `explainer_*.py`                                                            | Isolated experimental arms, their offline preflights, scheduling, and audits                             |
| `explorer.py`, `explorer.html`, `archive.py`                                | Earlier multi-study explorer and historical run archive                                                  |
| `test/`                                                                     | Synthetic regressions and separate public-API world smokes                                               |

The current prompts and provider runner depend on `harness_protocol.py`, not the
legacy Ollama runner. Its constants are shared verbatim. `runner.py` still
imports them under their old names for compatibility, and both runners retain
the module in new source snapshots.

## Data, identity, and writes

Acquisition uses public application APIs, never private databases or evaluator
answers. It is fixed across SDK tasks rather than selected by task ID. Source
IDs identify provider records; reference fields in the SDK are canonical graph
IDs. The graph adopts records and translates references between these
namespaces. `MusicLibrary` membership is distinct from the public catalog.
Payment groups are owned by a supervisor and a relationship kind; combining
groups can duplicate people or payments. See [coverage](COVERAGE.md) for
concrete caller examples.

Transaction creation times use `localDateTime({ precision: 'second' })` and
retain AppWorld's timezone-free calendar values. Historical reports describing
plain strings predate that adoption. Do not infer UTC from those values.

Writes cross two independent state owners: the provider journal and Relate's
runtime. The host reserves an operation before dispatch and retains a confirmed
provider output before attempting readback. Graph refresh can remain pending; a
lost response remains uncertain. Music mutations currently refresh the full
music snapshot. [WRITE_RECOVERY.md](../WRITE_RECOVERY.md) owns the recovery
contract and its limitations.

`explainer_support.py` produces acquisition metadata for the historical coverage
treatment. The current graph accepts but does not consume the `options` value;
it does not publish that experimental `collectionCoverage` contract.
`test/test_explainer.py` checks that metadata and treatment isolation.
`test/coverage.test.mjs` separately demonstrates that exhausted traversal covers
adopted records, not undiscovered provider rows.

## Artifact lifecycle

```text
.local/batches/<batch>/manifest.json       schedule, build/source hashes, status
.local/runs/<run>/config.json              execution config, prompts, source hashes
.local/runs/<run>/source/                  exact execution source copies
.local/runs/<run>/<task>__<condition>__<repeat>/
  requests.json                           attempted calls, including unknown usage
  steps.json                              returned responses saved before execution
  initial_messages.json / final_messages.json
  result.json / evaluation.json / api_calls.json
  source-writes.sqlite3 / music-writes.sqlite3  when applicable
.local/world/experiments/outputs/          AppWorld outputs and scoring artifacts
evidence/                                 public reports and encrypted bundles
```

A model response is persisted before its code executes. A crash can therefore
leave a billed step with pending execution and no final result. Usage accounting
must read retained steps and request attempts, not just completed results.
Historical ergonomics eligibility requires its exact twelve-result matrix; that
denominator is not the rule for the newer 96- or 138-attempt batches.

The first two-model logger retained mutable request history. The reporting tools
reconstruct dispatch-time prefixes into separate `request_transcript.json`
derivatives from retained messages/responses; original traces remain unchanged.
The current logger deep-copies request payloads.

## Why some filenames remain historical

Reports, executable scripts, and evidence retain their established paths because
archived source manifests, study validators, exported viewers, and linked PRs
refer to them. Renaming a runner also affects Node filesystem allowlists and
source snapshot lists. Use the guide and study indexes to navigate these files;
do not delete an old runner merely because the current batch does not use it.

Recorded evidence is immutable input to cleanup. New checks should write under
ignored `.local/` with distinct names. Reproducing an old score requires its
frozen source and SDK revision; running today's checkout produces a new study.
Model-visible prompts, graph descriptions, budgets, pagination, acquisition, and
write recovery are experimental behavior, even when an edit looks like wording
or maintenance. Change them only as an explicit intervention.
