# Main query update and expanded subset: frozen plan

Run `sdk-nano-queries-v1` follows `sdk-nano-contact-graph-v1`. Main `2cf7f92`
was merged as `fea6069`, including scalar predicates/timestamps (`#21`,
`406f388`) and the shared typed consumer (`#22`). The existing graph
property-description update `334db11` is preserved. The merge conflict in
.prettierignore was resolved by retaining both research and generated-doc
ignores.

No new SDK, graph, acquisition, prompt, REPL, action, completion or scoring
implementation is added in this experiment. The graph's AppWorld timestamps
remain timezone-free strings; range predicates require numbers or explicitly
typed timestamps. We do not reinterpret these strings as UTC instants. Equality
and in predicates can apply to existing scalar fields; numeric ranges can apply
to amount, duration and counts. SDK discovery teaches the current contract.

Retain tasks afc0fce_1, afc0fce_2, d0b1f43_1. Add afc0fce_3 (roommate write
variant), e7a10f8_3 (new playlist-duration instance), and 82e2fac_1 (playlist
popularity read previously used in the older read study). Additions are selected
by public task instructions and supported data/action coverage before execution,
without solutions or evaluator internals. Six training instances across four
families; three write instances are variants of one family. This is not a
held-out leaderboard run or a new-domain expansion.

Raw Python, raw TypeScript and Relate SDK, two repeats: 36 fresh episodes. Same
nano low reasoning, 28 turns, world seed 100, no provider seed; 4096 output
tokens/request, 14000 generated tokens/episode, 14000 visible characters/turn,
60-second execution timeout, $2 run cap. Static notes remain retired. No
retries, per-turn reminders, model switch or prompt changes after viewing
outcomes.

Report all six-task results and the original three-task subset separately.
Compare the original subset with the preceding run, including matched-success
turn/token comparisons, completion, source calls, cost and query-predicate use.
Fresh stochastic trajectories are not matched prefixes. The main SDK changes and
graph descriptions form one combined intervention, not separate ablations.

Pre-run: package rebuild, 18 Python tests, 11 Node tests and original AppWorld
write/readback/receipt-replay smoke. All new work stays in
dev/research/appworld.
