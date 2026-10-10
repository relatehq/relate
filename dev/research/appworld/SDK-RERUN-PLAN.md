# Nano rerun after operation discovery

Frozen before model execution on 2026-10-09.

- SDK base: main `60f0ff2`, including operation contracts and named request
  errors from PR #18 (`245308f`).
- Model: `gpt-5.4-nano`, low reasoning, three repeats.
- Tasks: existing `e7a10f8_1`, `d0b1f43_1`; additions `82e2fac_1`, `d0b1f43_2`.
- Selection: training instructions only, before execution; added playlist-song
  popularity selection and incoming contact-group payment aggregation. These fit
  the existing acquired collections. The added payment task is a same-family
  variant, not an independent task family.
- Conditions: raw API Python, static notes Python, real SDK TypeScript/Node.
- Only harness behavior change: a shared system instruction says printing is
  insufficient, numeric answers contain only the value, name/title answers
  contain only that value, and task-specific format requirements take
  precedence.
- Per-turn completion feedback: disabled.
- Unchanged: fixed union acquisition, graph model, static notes, persistent
  interpreters, model tool protocol, 14 turns, 4,096 output tokens per request,
  14,000 generated-token episode budget, 14,000 output characters, low
  reasoning, counterbalanced condition order, world seed 100, original
  evaluator.
- Cost limit: $3 estimated model cost for the full 36-episode run.
- No task solutions or evaluator ground truth are consulted for selection or
  exposed to the agent.
- Record all episodes, including failures. No automatic mini substitution or
  prompt tuning after observing results.

The preceding study changed both SDK version and completion instructions
relative to this one. A before/after comparison cannot isolate the causal
contribution of either change. Results on the two added tasks must be separated
from matched-task comparisons.
