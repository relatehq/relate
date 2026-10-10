# Independent ergonomics spikes: frozen screening protocol

Start from SDK main `2cf7f92` and research graph/harness `51c5484`. No SDK
implementation is added to the research branch. SDK spikes execute in an
isolated main-based worktree, with independent commits/branches. The same
research harness is copied there as ignored experiment support. Frozen sources,
SDK commit IDs and sanitized results identify every arm.

Six training tasks, SDK only, two repeats per arm: afc0fce_1, afc0fce_2,
d0b1f43_1, afc0fce_3, e7a10f8_3, 82e2fac_1. Keep nano low, 28 turns, 4096 output
tokens/request, 14000 generated tokens/episode, 14000 visible characters,
60-second execution timeout, world seed 100 and no provider seed. Prompts,
acquisition, REPL semantics and completion are unchanged. Prior raw results stay
as context; this experiment isolates SDK and graph changes, not a new method
ranking. Each graph-only arm uses unchanged main SDK packages.

Independent arms (each differs from baseline only by its named intervention):

1. Fresh unchanged baseline.
2. Action discovery: invocation and succeeded/failed receipt contracts, output
   location, stable-key retry semantics.
3. Errors: accepted read operators in text and authorized field-specific action
   input validation. No action semantics or source retry behavior changes.
4. Query discovery: executable examples distinguishing the lazy iterable handle
   from one awaited page. No new query methods or materialization behavior.
5. Contact descriptions: group selection requires owner and kind; multiple
   labels per person; transaction direction does not imply contact group.
6. Date descriptions: concise local-clock representation and explicit current
   filtering boundary. Keep source values and string types; no UTC conversion
   and no new datetime type.

Screening: retain all attempted episodes. An arm qualifies for confirmation if
it has more official passes than the fresh baseline, or equal passes with at
least 10% fewer mean turns or input tokens without more than 10% regression in
the other efficiency measure. This is a small-sample screening rule, not a
significance test. For promising arms, run two more repeats against a second
fresh baseline, unchanged implementation. Confirmation must not lose accuracy
against its contemporary baseline; the combined screening+confirmation result
must still meet the same improvement rule. Inspect mechanism-specific errors and
matched successful cases before promotion. Negative results remain public.

Open separate main-targeted PRs only for SDK arms meeting that evidence rule and
focused correctness checks. Explain small-sample and multiple-comparison limits.
Graph-only changes remain research proposals/results, never SDK PRs. Do not
combine treatments or change prompts after viewing results. No SDK spike code
remains on the research branch. Preserve isolated experiment commits for
provenance; delete no unrelated branches or worktrees.

Model spending: $2 maximum for the entire batch, checked between arms, with
per-run caps constrained by the remaining amount. No model switch or hidden
retry. If confirmation cannot fit, report it as unconfirmed rather than promote.
