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
