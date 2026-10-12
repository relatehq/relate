# Development and reproduction

Commands start at the repository root unless a block explicitly changes
directory. The research Node worker requires **Node 26** for its
permission-constrained REPL. The retained Python environment uses **Python
3.11.6** and `requirements.lock`. Core Relate's supported Node versions do not
imply this research harness runs on all of them.

## Install and run offline checks

```sh
pnpm install
pnpm build
cd dev/research/appworld
uv venv --python 3.11.6 .venv
uv pip sync --python .venv/bin/python requirements.lock
.venv/bin/appworld install
.venv/bin/appworld download data --root .local/world
```

From the repository root:

```sh
node --test dev/research/appworld/test/*.test.mjs
dev/research/appworld/.venv/bin/python -m unittest discover \
  -s dev/research/appworld/test -p 'test_*.py' -v
pnpm check:boundaries
```

These research suites are separate from the root Vitest suite. Python tests
include host/Node bridge checks, synthetic provider responses, request
accounting, and recovery; they make no paid model calls. Node tests cover both
the legacy and current graph adapters. Rebuild Relate after changing SDK
packages.

For changes to acquisition or writes, also run the relevant public-API world
checks. They use local train/dev worlds and simulated mutations, not a model:

```sh
dev/research/appworld/.venv/bin/python dev/research/appworld/task_catalog.py
dev/research/appworld/.venv/bin/python dev/research/appworld/test/expanded_preflight.py \
  --output dev/research/appworld/.local/cleanup-preflight.json
dev/research/appworld/.venv/bin/python dev/research/appworld/test/expanded_write_smoke.py
dev/research/appworld/.venv/bin/python dev/research/appworld/test/sdk_write_smoke.py
dev/research/appworld/.venv/bin/python dev/research/appworld/test/raw_ts_smoke.py
dev/research/appworld/.venv/bin/python dev/research/appworld/test/sdk_persistence_smoke.py
```

`expanded_preflight.py` defaults to overwriting its tracked evidence report; use
an explicit `.local/` output for routine checks. Study-specific `validate_*.py`
scripts may require restored archives, an exported viewer, and local credentials
for redaction checks. They are not generic smoke tests. `action_realm_repro.mjs`
is a retained diagnostic reproduction, not an additional required suite.

For repository validation use `pnpm check` with the worktree's configured
disposable Postgres database. See the root `AGENTS.md` for check requirements. A
historical validation JSON describes its recorded revision, not the current
checkout.

## Start a new evaluation

This command makes paid provider calls. Give every new run a new name and set an
explicit cost ceiling. The host-only dotenv file needs `OPENAI_API_KEY` and/or
`ANTHROPIC_API_KEY` for the models selected. Do not place secrets in command
arguments or tracked files.

```sh
dev/research/appworld/.venv/bin/python dev/research/appworld/two_model_eval.py \
  --batch my-new-comparison --task-set baseline \
  --models gpt-5.4-nano claude-haiku-5-5 \
  --conditions raw raw_ts sdk snapshot_ts \
  --credentials /path/to/local/.env --jobs 3 --max-cost-usd 20
```

`baseline` selects 12 instances; `expanded` selects the 69 additional instances.
`--tasks` selects an explicit subset. The scheduler dispatches each selected
(task, model, condition) once, with 28 turns, 4,096 output tokens/request and
14,000 generated tokens/episode. Names cannot be reused; incomplete attempts are
retained and there is no automatic retry. The direct `sdk_runner.py` CLI has
different defaults (including 14 turns); use the batch scheduler for this
protocol and inspect `--help` before a custom study.

Provider prices in `model_provider.py` are frozen research estimates used by the
retained audits. They are not a live pricing feed. Changing prompts, limits,
models, acquisition, or SDK revisions defines a new comparison; record the
change rather than replacing old scores. The [study index](STUDIES.md) links
each historical protocol and its frozen revision. The [Ollama guide](OLLAMA.md)
covers the original local-model runner.

## Inspect and retain a batch

The current explorer consumes `.local/batches/<batch>` and its associated runs.
It exports protected data outside the repository:

```sh
dev/research/appworld/.venv/bin/python dev/research/appworld/results_explorer.py \
  --batch my-new-comparison --output /tmp/appworld-my-new-comparison
python3 -m http.server 8765 --bind 127.0.0.1 \
  --directory /tmp/appworld-my-new-comparison
```

Open `http://127.0.0.1:8765`; stop the server with Ctrl-C when finished. The
viewer contains instructions, records, and full trajectories and is for local
use. `explorer.py` is the separate, earlier multi-study viewer with frozen run
lists.

After a new batch finishes, audit it and retain its encrypted archive:

```sh
dev/research/appworld/.venv/bin/python dev/research/appworld/audit_two_model.py \
  --batch my-new-comparison
dev/research/appworld/.venv/bin/python dev/research/appworld/archive_batch.py \
  --batch my-new-comparison
```

The audit writes `evidence/<batch>-results.json`. The archiver refuses an
existing bundle, restores into a temporary directory, and compares every file
hash before writing `evidence/<batch>-archive.json`. Do not rerun these commands
against a retained study as a routine cleanup check. Export and audit tools do
not require provider calls.

## Restore historical evidence

The original archive restores to `.local/restored/runs`:

```sh
dev/research/appworld/.venv/bin/python dev/research/appworld/archive.py unpack
```

Batch archives use a different layout. This restores a retained batch into an
isolated directory without merging it into active runs:

```sh
dev/research/appworld/.venv/bin/python - <<'PY'
from pathlib import Path
from appworld.common.constants import PASSWORD, SALT
from appworld.common.utils import unpack_bundle

root = Path('dev/research/appworld')
target = root / '.local/restored-expanded-haiku'
target.mkdir(parents=True, exist_ok=False)
unpack_bundle(
    bundle_file_path=str(root / 'evidence/expanded-haiku-20261012.bundle'),
    base_directory=str(target), password=PASSWORD, salt=SALT,
)
PY
```

Batch contents are `batch/`, `runs/`, and `world-outputs/`; the corresponding
`*-archive.json` records expected hashes. To use a restored batch with the
viewer, place copies of `batch/` and its runs under the matching
`.local/batches/<batch>` and `.local/runs/` paths in an isolated checkout,
without replacing existing artifacts. See the
[evidence index](../evidence/README.md) for archive ownership.
