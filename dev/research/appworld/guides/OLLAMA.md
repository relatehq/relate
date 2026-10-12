# Original Ollama study: reproduction and adapter contract

This guide describes the historical `runner.py` / `graph.mjs` experiment. For
the current provider-backed harness, use [DEVELOPMENT.md](DEVELOPMENT.md).
Commands below run from `dev/research/appworld` unless stated otherwise.

## Reproduce the original Ollama study

For the direct-SDK study, use the separate commands in
[SDK-STUDY.md](../SDK-STUDY.md) and Node 26 (the REPL uses its filesystem and
network permission controls). The original recorded runs used commit `50b83f1`;
use that revision or the archived source snapshots for historical reproduction.
The compatibility adapter now explicitly requests full evidence before its old
projection so current compact-by-default packages do not silently change the old
arm labels.

From the repository root, run `pnpm install` and `pnpm build`. Then:

```sh
cd dev/research/appworld
uv venv --python 3.11.6 .venv
uv pip sync --python .venv/bin/python requirements.lock
.venv/bin/appworld install
.venv/bin/appworld download data --root .local/world
ollama list
```

Use an already installed local model. The runner calls only
`http://localhost:11434/api/chat`; it has no cloud-model fallback.

```sh
.venv/bin/python runner.py \
  --model qwen3.6:27b --think false --bootstrap \
  --run reproduction-v1 \
  --tasks e7a10f8_1 d0b1f43_1 \
  --conditions raw static flat full compact \
  --seeds 11 --steps 14 --context 16384
```

The separate, post-hoc documentation follow-up used the same model and budgets:

```sh
.venv/bin/python runner.py \
  --model qwen3.6:27b --bootstrap --clarify-interface \
  --run reproduction-docs-v2 --tasks d0b1f43_1 \
  --conditions flat compact --seeds 11 --steps 14 --context 16384
```

`--clarify-interface` documents response envelopes and canonical reference IDs
with an example, and removes unavailable traversal docs from the flat condition.
It changes prompts only. Omit it to reproduce the original conditions. This
follow-up was selected after reading primary traces; it is not held-out
evidence.

A run name is immutable. Choose a new name for repetitions. Each run saves its
configuration, code snapshots and hashes; each episode saves its trajectory,
original evaluator output, API calls and metrics. Model seeds are not a
guarantee of bitwise determinism across Ollama versions or hardware. Canonical
graph IDs are regenerated per world, so their literal strings also differ.

## Original Ollama conditions (historical)

| Condition | Agent access                                                          |
| --------- | --------------------------------------------------------------------- |
| `raw`     | Original APIs and persistent Python execution                         |
| `static`  | Original APIs plus relationship/field interpretation notes            |
| `flat`    | The notes plus a normalized bulk snapshot, list/get and Python joins  |
| `full`    | The same acquisition plus Relate get/traverse and full field evidence |
| `compact` | The same Relate operations with compact evidence                      |

The bulk control shares snapshot construction and identifier assignment with the
graph conditions; it reads normalized records directly rather than invoking
Relate reads/traversal. It controls for acquisition and normalization, not all
possible semantic-model effects. Only the raw condition is a no-model baseline.

The primary study uses `--bootstrap`: every condition starts with the same
host-authenticated Spotify, phone and Venmo sessions. Four setup API calls are
counted separately. This focuses the comparison on data access after login. It
also adds explicit interpreter initialization instructions equally to all
conditions.

All conditions retain original write APIs. This historical adapter implements no
Relate MCP, source writes, query planning or aggregation. An experimental
`research` Python function bridges to a task-local Node process calling
`@relate/node`.

Two snapshot domains are available:

- Music: all playlist-library pages, unique songs and membership junctions.
- Payments: all email-bearing phone contacts and the user's Venmo transactions,
  joined by exact email, with directional sender/receiver references.

Original APIs acquire all data. The graph never reads AppWorld's private
database or evaluator. Snapshots are invalidated after original API writes. This
deliberately conservative mechanism is not a production freshness
implementation. Field provenance describes the application snapshot, not a live
provider authorization.

`list` is an adapter-owned enumeration of adopted records. `traverse` runs
through Relate's actual runtime and consumes continuation pages. The adapter
combines page data and reports exhaustion; it does not preserve every original
page-level metadata field. These historical operations do not describe the
current SDK query contract.

## Original Ollama validation and diagnostics

```sh
node --test test/*.test.mjs
.venv/bin/python -m unittest discover -s test -p 'test_*.py' -v
.venv/bin/python probe_adapter.py
node measure.mjs
.venv/bin/python summarize.py reproduction-v1 --output .local/reproduction.json
```

The integration probe uses a training world, explicit scripted login and public
reads. It is a deterministic adapter check, **not an agent success result**.
`measure.mjs` uses synthetic records to isolate response-size scaling and
paging; it is also separate from task scores.

The compact renderer keeps completeness/degradation and exceptional field
status, including forbidden, unavailable and stale values. It omits repetitive
positive field evidence. It is an experimental projection, not a complete
production contract for warnings, ordering, durability or provenance. Tests
check value equivalence, retained exceptions, identity separation, many-to-many
links, directionality, pagination and world reset.
