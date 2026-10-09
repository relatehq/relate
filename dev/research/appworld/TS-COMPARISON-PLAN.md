# Raw TypeScript comparison: frozen run plan

Frozen before model execution on 2026-10-09.

- Run: `sdk-nano-uniform-ts-v1`.
- Model: GPT-5.4 nano, low reasoning; no automatic switch to mini.
- Six training tasks: `e7a10f8_1`, `d0b1f43_1`, `82e2fac_1`, `d0b1f43_2`, plus
  `e7a10f8_2` and `d0b1f43_3`.
- Additions: shortest-playlist aggregation and bidirectional contact-group
  payment aggregation. Selected by instructions before execution; no solutions
  consulted. These are variants of existing families, not new independent task
  families. Acquisition and graph modeling remain unchanged.
- Four conditions: `raw` Python APIs; `static` Python APIs plus existing notes;
  `raw_ts` original APIs in Node; `sdk` SDK-only in the same Node worker.
- Three repeats; 72 episodes; counterbalanced condition order; world seed 100;
  no provider seed.
- Uniform shared rules from the pinned AppWorld ReAct prompt, with documented
  environment substitutions. See [prompt provenance](PROMPT-PROVENANCE.md).
- Raw TS has API discovery, original named arguments and JSON responses,
  original manual pagination, source tokens and task completion. It gets no
  graph, snapshot or pre-acquisition. SDK has graph discovery/reads and task
  completion, without original APIs or source credentials. Both use identical
  REPL persistence, console capture, TS transpilation and Node permissions.
- Common host authentication and original evaluator. Direct Node completion and
  API effects are flushed to the original evaluator input.
- Unchanged budgets: 14 turns, 4,096 output tokens/request, 14,000 generated
  tokens/episode, 14,000 visible characters/turn, 60-second execution timeout.
- Per-turn completion feedback disabled. Estimated model cost limit $3.
- Preserve all episodes and errors; no prompt/environment tuning during the run.

This comparison reduces the language/runtime confound for raw TS versus SDK. It
does not isolate graph relationships from pre-acquisition, normalized
collections or authored semantics. Historical comparisons additionally change
prompt content, available capabilities and task coverage; do not pool them.
