# Explicit no-answer completion: frozen plan

Run `sdk-nano-no-answer-v1` compares raw Python, raw TypeScript and Relate SDK.
Static notes are retired from future comparisons; historical results remain.

Against `sdk-nano-writes-28-v1`, the only agent-visible change is an explicit
no-answer completion example in the system prompt: `apis.supervisor.complete_task()`
in Python and `await completeTask()` in both Node environments. No SDK changes.

Retain the same three tasks (`afc0fce_1`, `afc0fce_2`, `d0b1f43_1`), two repeats,
GPT-5.4 nano low reasoning, 28 turns, seed 100, 4096 output tokens/request,
14000 generated tokens/episode, 14000 output characters/turn, $2 run limit,
source acquisition and original evaluator. No per-turn feedback or retries.
Removing static changes condition rotation; these are fresh stochastic episodes,
not matched prefixes. Compare only the three retained methods (18 episodes).

Report official success, correct write state, answer-only failures, completion,
time, turns, tokens and estimated cost. Preserve all trajectories. Any further
prompt or SDK change requires a separate experiment.
