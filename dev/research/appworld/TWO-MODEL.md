# Current main: Haiku 5.5 and GPT-5.4 Nano

This evaluation runs the twelve implemented train/dev instances once through
each of four interfaces on two models: **96 episodes**, with no repeats,
holdout, confirmation, candidate SDK branches, or automatic request/episode
retries.

- Models: `gpt-5.4-nano` and `claude-haiku-5-5`, low reasoning effort.
- Interfaces: Python original APIs (`raw`), TypeScript original APIs (`raw_ts`),
  Relate (`sdk`), and normalized arrays with shared SDK-backed writes
  (`snapshot_ts`).
- Tasks: instances 1, 2, and 3 of `e7a10f8`, `82e2fac`, `d0b1f43`, and
  `afc0fce`.
- SDK: current main `4e002ab`, including PR 26. The graph now adopts
  `localDateTime({ precision: 'second' })` for transaction creation dates.
- Limits: 28 turns, 4,096 output tokens/request, 14,000 generated
  tokens/episode, 14,000 visible output characters, world seed 100, 60-second
  execution timeout.
- Scheduling: three isolated processes; one dollar reserved per episode under a
  shared $20 ceiling. Unused allowance is released. Each episode is dispatched
  once.
- Anthropic uses adaptive thinking and automatic single-tool selection. OpenAI
  retains the existing forced single-tool protocol and encrypted reasoning
  replay. This provider protocol difference is recorded, not hidden.

The host reads both provider keys from the main checkout's `.env`. Neither key
enters the interpreter, config, request artifacts, browser export, or
repository. The tracked `.env.example` contains empty placeholders only.

## Coverage and scoring

AppWorld's official evaluator scores each final world. Incomplete infrastructure
attempts remain visible with null success. Task completion and official success
are separate fields. No successful or failed episode is discarded.

The SDK and snapshot interfaces share host acquisition and normalized data.
Snapshot writes still use the SDK action adapter. This is a read-interface
comparison, not a wholly SDK-free control. Music acquisition includes playlist
songs; `82e2fac_2` and `82e2fac_3` ask about song/album libraries beyond that
acquisition contract. Their coverage limitation is retained in the full matrix.

## Retention

Every provider request body and full returned JSON, replay content, initial and
final messages, code cell, complete execution output, model-visible output,
source API call, usage record, evaluator result, and write journal is retained
under `.local/runs/`. Provider HTTP failures retain their bodies without
headers; network failures with no returned usage are marked as unknown billing.

The batch manifest records the exact schedule, dispatch status, source hashes,
commit, limits, costs, and every exit code. The archive includes all new run
folders and their AppWorld output directories. Archive restoration is verified
against SHA-256 file hashes. Existing runs and archives remain unchanged.

## Run

From the repository root, after building and offline checks:

```sh
dev/research/appworld/.venv/bin/python dev/research/appworld/two_model_eval.py \
  --batch main-two-model-20261012 \
  --credentials /Users/dennis/dev/vs/relate/.env --jobs 3 --max-cost-usd 20
```

The batch directory must not already exist. This command cannot silently resume
or overwrite a prior attempt. There are no automatic retries.

## Explore retained results

Build the local-only viewer, then serve its output directory:

```sh
dev/research/appworld/.venv/bin/python dev/research/appworld/results_explorer.py \
  --batch main-two-model-20261012 \
  --output /Users/dennis/dev/vs/relate-results/main-two-model-20261012
python3 -m http.server 8765 --bind 127.0.0.1 \
  --directory /Users/dennis/dev/vs/relate-results/main-two-model-20261012
```

Open `http://127.0.0.1:8765`. Filters update the matrix, totals, and run table.
Select any matrix cell or table row to inspect its initial prompt, code cells,
model-visible output, full provider responses, evaluator, and source API calls.
Each original artifact is downloadable; CSV export follows the active filters.

The first frozen logger kept a mutable reference to OpenAI's request history, so
the `provider_request.input` field in original `steps.json` grew after each
request. Initial/final messages and all provider responses were retained intact.
The viewer and archive contain a separate `request_transcript.json` that
restores each exact dispatch-time history prefix and verifies its response
positions against the final conversation. Original trace files are unchanged.
The logger is fixed for future batches after this batch finishes; no episode is
rerun.

To audit scoring and usage, then create and byte-verify the separate encrypted
archive (each command is offline):

```sh
dev/research/appworld/.venv/bin/python dev/research/appworld/audit_two_model.py \
  --batch main-two-model-20261012
dev/research/appworld/.venv/bin/python dev/research/appworld/archive_batch.py \
  --batch main-two-model-20261012
```

## Results

Completed all **96 attempts once**: **61 passed, 32 failed, and 3 incomplete**.
No repeats, retries, holdouts, or confirmation rounds ran. The batch took 12.8
minutes. All **970 provider requests** have recorded usage; estimated total cost
was **$0.5867**.

| Model            | Interface           | Passed | Failed | Incomplete | Mean turns | Estimated cost |
| ---------------- | ------------------- | -----: | -----: | ---------: | ---------: | -------------: |
| gpt-5.4-nano     | Raw Python          |      7 |      5 |          0 |      18.50 |        $0.1026 |
| gpt-5.4-nano     | Raw TypeScript      |      7 |      5 |          0 |      17.50 |        $0.1110 |
| gpt-5.4-nano     | Relate SDK          |      7 |      5 |          0 |      12.33 |        $0.0824 |
| gpt-5.4-nano     | Snapshot TypeScript |      8 |      4 |          0 |      11.42 |        $0.0773 |
| claude-haiku-5-5 | Raw Python          |     11 |      1 |          0 |       5.08 |        $0.0480 |
| claude-haiku-5-5 | Raw TypeScript      |      8 |      1 |          3 |       5.75 |        $0.0589 |
| claude-haiku-5-5 | Relate SDK          |      7 |      5 |          0 |       5.50 |        $0.0607 |
| claude-haiku-5-5 | Snapshot TypeScript |      6 |      6 |          0 |       4.75 |        $0.0458 |

All three incomplete episodes were Haiku raw-TypeScript runs: `e7a10f8_2`,
`d0b1f43_1`, and `afc0fce_1`. Awaiting a proxied API object dispatched a
nonexistent `then` API and caused an unhandled rejection in the existing REPL.
These attempts were not retried or counted as ordinary task failures. Their
official evaluator output, error, provider responses, usage, and application
calls remain accessible.

The same 12 tasks and literal budgets are used across both models. The provider
tool-choice protocols differ, and the SDK/snapshot acquisition scope is narrower
than the raw APIs for two music-library instances. These selected single
attempts are descriptive results, not a broad benchmark or a causal SDK-uplift
claim.

[Audited per-episode metrics](evidence/main-two-model-20261012-results.json) and
[archive verification](evidence/main-two-model-20261012-archive.json) accompany
the separate encrypted `main-two-model-20261012.bundle`. The evaluated source is
`4f83d0775f9b`, with exact runner snapshots and SDK build hashes retained. The
request-logging fix made after the batch does not change any evaluated episode.

Validation: full `pnpm check` passes (997 tests including Postgres and
packaging); 47 Python research tests and 13 Node research tests pass. All 24
offline SDK/snapshot task preflights pass. The browser checks cover task,
family, model, interface and outcome filters, full trajectories, evaluator
views, original files, and the incomplete-run view.
