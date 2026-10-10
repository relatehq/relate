# Write-task turn-budget comparison: frozen plan

Approved continuation of the first write pilot. Run `sdk-nano-writes-28-v1`
changes only the turn limit from 14 to 28 relative to `sdk-nano-writes-v1`.

- Same three training tasks: `afc0fce_1`, `afc0fce_2`, `d0b1f43_1`.
- Same four methods: raw Python, static-notes Python, raw TypeScript, Relate
  SDK.
- Same two repeats per task/method, rotating condition order: 24 fresh episodes.
- Same GPT-5.4 nano model, low reasoning, world seed 100; no provider seed.
- Same six execution-source hashes and exact system prompts as the 14-turn run.
- Same SDK revision, including main's realm fix `5a0af21`; no main refresh.
- Same 4,096 output tokens/request, 14,000 generated tokens/episode, 14,000
  visible output characters/turn and 60-second code execution timeout.
- Same $2 estimated run-cost stop, source acquisition, task completion and
  original AppWorld evaluation. No per-turn reminders or oracle feedback.
- No prompt/harness changes during execution, retries to improve scores or
  switch to mini. Preserve every attempted episode and error.

The comparison is between fresh stochastic runs, not an exact continuation of
the previous trajectories. Cases match by task, method and repeat index, but
provider randomness and freshly generated graph identities mean the first 14
turns can differ. Success before turn 15 in the new run is not direct evidence
that the larger limit caused it. Success after turn 14 demonstrates use of the
additional opportunity; it is still not a matched-prefix causal experiment.

Report original task success, write-state checks separately, completion, first
mutation turn, success after turn 14, stopping reason, time, turns, token usage,
cost and request counts. Retain the 14-turn study separately in the explorer.
Report incomplete API iteration, incorrect target selection and REPL recovery
without silently repairing agent code or modifying the SDK.

All work remains in `dev/research/appworld`. If a new SDK change is needed,
pause for agreement. This experiment does not authorize further task expansion
or a completion-prompt change.
