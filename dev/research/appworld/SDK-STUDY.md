# Direct SDK study

This follow-up replaces the experimental `research()` agent interface with the
current public Relate SDK. The raw and static-note agents retain AppWorld's
persistent Python interpreter. The Relate agent uses a persistent TypeScript
REPL in a separate Node process. It receives the actual authenticated consumer,
not a replacement graph API.

## Initial protocol fixed before the first paid pilot

- SDK baseline: upstream main `1556498`, including query (#13), compact evidence
  (#15), explicit through traversal (#16), and actor-bound discovery (#17).
- Model: `gpt-5.4-nano`, reasoning `none`; use `gpt-5.4-mini` if pilot evidence
  warrants it. Models are always compared within a model, never pooled.
- Tasks: the same two previously studied training cases, `e7a10f8_1` and
  `d0b1f43_1`. They are familiar exploratory cases, not held-out validation.
- Conditions: Python raw APIs; Python APIs plus the original static notes;
  TypeScript original APIs plus the actual Relate consumer.
- Initial pilot: one episode per task/condition. Retain failures and distinguish
  harness repairs from model/SDK findings. Freeze the subsequent main run and
  repeat each task/condition three times with counterbalanced condition order.
- Budgets: 14 turns, 1,600 output tokens per request, 14,000 generated tokens
  per episode, 14,000 visible output characters per cell. Execution timeout is
  60s.
- Responses API, strict JSON code output, no tools, no provider seed, no
  retained server conversation (`store: false`). Repetitions are independent
  attempts, not deterministic seeds. AppWorld's world seed remains 100.
- A $2 estimated-cost ceiling bounds the pilot; a $5 ceiling bounds a main run.
  Cost accounting uses published token rates, including cached input; it is an
  estimate, not an invoice. Each request reserves a conservative input-byte /
  maximum-output bound against the cap.

## What the agent knows

The TS system prompt names `relate.describe()` and
`relate.objects[apiName].describe()`, alongside the original app documentation
entry points. It does not enumerate graph objects, properties, relationships,
query syntax, IDs or task-solving examples. Domain descriptions live on the
hand-authored graph and arrive only when the agent calls discovery. SDK
`describe()` is capability/schema discovery; whether it supplies enough
operation syntax to an unfamiliar model is part of the experiment.

All conditions receive the same task text, supervisor context, simulated date,
and host-authenticated Spotify, Phone and Venmo tokens. TS original API methods
are asynchronous and accept a named-argument object; they dispatch to the exact
same AppWorld API collection used by Python. Their responses and evaluator state
are not mocked. The agent completes through AppWorld's supervisor API.

The TS REPL supports top-level await, persistent declarations and recoverable
syntax/runtime errors. TypeScript syntax is transpiled, not statically checked.
Only printed output is returned. Node permissions deny network, child processes,
workers and reads outside the allowlisted code/dependencies. The host's OpenAI
key, task files, environment files and evaluator are not passed into the child.
The VM context is not itself treated as a security boundary.

## Data and ownership

Python retains the original acquisition and normalization: playlist-library
pages and unique song details; contacts and own transactions joined by exact
email. Every SDK episode acquires the same union of music and payments,
regardless of task ID. Setup is eager and counted, rather than presenting it as
free agent work. No graph schema or identity rule is learned automatically.

Node binds those normalized records through a snapshot connector, adopts them,
and gives the agent `runtime.as(reader)` as `relate`. `query()`, `get()`,
traversal, descriptions and compact evidence execute in public packages.
`Playlist.traverse.songs()` is declared using a `through` relationship over the
existing Membership object. The original membership traversals remain available.
There is no custom list implementation or compact-evidence projection on this
path. Source writes invalidate the snapshot consumer before the TS API promise
resolves; these selected tasks are read-only, so no reload API is introduced.

## Interpretation boundaries

This is a comparison of complete setups. Language, discovery interface,
pre-acquisition, hand-authored semantics and graph execution differ together. A
better score or fewer turns is not a causal estimate of graph structure alone.
Raw/static share Python; their difference is the semantic-note ablation.

Track accuracy and completion separately, turns, summed input/output/cache
tokens, estimated cost, model latency, setup/acquisition time, total episode
wall time, all underlying source calls and agent-time calls. SDK snapshot
fetches are local connector reads, not provider calls. Setup time includes
environment initialization, authentication, source acquisition and Node
adoption.

The AppWorld evaluator runs after the agent exits. Evaluation data is never
returned to the agent. Exact task text, answer-bearing data and traces remain in
ignored `.local/runs/` and the protected AppWorld archive. Public evidence
contains aggregate metrics and sanitized failure categories.

## Reproduce

After the original AppWorld installation instructions in README:

```sh
pnpm install --frozen-lockfile
pnpm build
cd dev/research/appworld
.venv/bin/python sdk_runner.py \
  --run sdk-reproduction \
  --tasks e7a10f8_1 d0b1f43_1 \
  --conditions raw static sdk --repeats 3 \
  --model gpt-5.4-mini --reasoning low \
  --credentials /path/to/local/credentials.env \
  --max-cost-usd 5
```

The credential file must contain `OPENAI_API_KEY`. Only the host reads it; the
path and value are excluded from saved configuration. No cloud fallback exists
in the original Ollama runner. This new runner explicitly uses OpenAI.

## Harness development and retained diagnostics

The initial nano pilot used a 1,600-token per-response cap and no reasoning. It
repeatedly truncated long code generations. The first mini pilot raised the cap
to 4,096 but also exposed two harness defects: response text from multiple
message phases was concatenated, and TS completion calls were not flushed to the
evaluator's normal disk output (a checkpoint alone is insufficient). Both SDK v1
pilot score sets are invalid and excluded from accuracy aggregates.

Before `sdk-mini-pilot-v2`, the harness selected the final-answer message,
preserved that phase in conversation history, flushed SDK state through a no-op
AppWorld execution, and added the same short-cell iteration instruction to all
conditions. The SDK prompt directs graph reads to the actual consumer and starts
at discovery; original APIs remain available for missing capabilities. The model
uses low reasoning and a 4,096-token response cap. No graph schema or method
signature examples were added to the prompt. The persistence regression submits
an arbitrary marker and checks that the original evaluator reads that marker
from disk; it does not supply a solution.

The corrected pilot completed all six episodes. It exposed SDK operation-syntax
and identity confusion, which remain unchanged for the main study. The main
`sdk-mini-main-v1` uses the same prompts, model, low reasoning, response cap and
budgets as v2, with three repetitions per task/condition (18 episodes).
Additional changes before freezing main only classify killed Node cells as
execution failures rather than infrastructure failures, record completion
explicitly, and extract response selection into a tested helper. These cases did
not occur in corrected pilot v2.

## Final protocol: explicit code execution

`sdk-mini-main-v1` is retained as a diagnostic, not the final comparison. During
that run, a response contained multiple commentary-phase proposed cells and a
final inability answer, without an execution boundary between them. Selecting
only the final message discarded the proposed cells. That was a code-action
protocol confound shared by every arm, not evidence of SDK failure.

The final runner uses one strict `execute_code` function tool, forced as the
next action with parallel tool calls disabled. Its argument is `{code: string}`;
it runs Python for raw/static and TS for SDK. It is an interpreter tool, not a
new graph API. Each call gets its actual output before the next model request.
The runner replays provider output items (including message phases and encrypted
reasoning for stateless requests) and attaches a matching
`function_call_output`. No commentary or final-message text is executed as code.
The old system prompt's JSON-output instruction becomes a language-specific
`execute_code` instruction; all other task/domain and iteration instructions
stay the same.

`sdk-mini-tool-pilot-v1` checks that loop, `sdk-nano-tool-pilot-v1` checks nano
on the corrected loop, and `sdk-mini-main-v2` is the final 18-episode
comparison. The first tool pilot also produced a response without a code call.
The runner initially classified that as infrastructure failure and omitted that
response's usage. Before the final run, this was changed to retain the full
response and usage and score the episode as `model-no-action` (unsuccessful if
the task was not completed). The partial `sdk-mini-main-v2` and
`sdk-nano-tool-pilot-v1` runs were stopped during this correction; their
coverage reports retain missing cells. The corrected nano check is
`sdk-nano-tool-pilot-v2`.

Both models use low reasoning, a 4,096-output-token cap and the same task/turn/
output budgets. The mini main run repeats each task/condition three times. No
model-quality ranking is inferred from differently configured earlier pilots.
The final comparison is frozen before it starts; SDK usability failures remain
observations rather than triggers to add task-solving prompt examples.

## Results

Results will be recorded after the final repeated run finishes.
