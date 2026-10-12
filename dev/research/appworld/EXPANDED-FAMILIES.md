# Additional single-app families: Haiku, raw Python and Relate SDK

## Frozen protocol

Scope: the 69 instances in the 23 additional single-app families listed in
`task_catalog.ADDITIONAL_TASKS` (22 Spotify families, one Venmo family).
Existing 12 instances are not rerun. One attempt per instance/interface on
`claude-haiku-5-5`, using raw Python (`raw`) and Relate SDK (`sdk`): **138
attempts**. No retries, repeat baselines, holdouts or confirmation rounds. Both
interfaces use the same task worlds, seed 100, low reasoning, 28 turns, 4,096
output tokens per request, 14,000 generated tokens per episode and 14,000
visible output characters. Execution timeout is 60 seconds; three isolated
episode processes. The batch reserves at most $1 per episode under a $20
aggregate ceiling.

Acquisition is fixed across SDK episodes, with no task routing. The raw
interface acquires through original APIs. Models receive task instructions and
public supervisor/date context, never reference solutions or evaluator
internals. Sources and built SDK files are hashed before dispatch. Each process
retains its source copy, request/response bodies, usage, code, output, final
world and official score. Incomplete attempts stay visible with null success;
failures are retained.

## Reproduction

From the repository root:

```sh
dev/research/appworld/.venv/bin/python dev/research/appworld/two_model_eval.py \
  --batch expanded-haiku-20261012 --task-set expanded \
  --models claude-haiku-5-5 --conditions raw sdk \
  --credentials /path/to/local/.env --jobs 3 --max-cost-usd 20
```

A batch name cannot be reused. Credentials remain host-only. Validation uses
`test/expanded_preflight.py`, `test/expanded_write_smoke.py`, Python research
tests and Node research tests. Preflight is not a model attempt or an official
score.

## Results

Pending the single frozen batch. No model success claims are made by the adapter
coverage inventory. Final results and archive verification will be recorded
here.
