# AppWorld graph-interface research

Status: primary ten-episode matrix completed; see [FINDINGS.md](FINDINGS.md). A
separate two-episode prompt-only follow-up also completed, investigating errors
observed in that matrix. No general performance or leaderboard claim is made.

Primary scope is now frozen in `covered-v1`: two explicitly matched training
tasks (playlist-duration aggregation and contact/payment aggregation), all five
conditions, local Qwen 3.6 27B, seed 11, 14 agent turns, 16,384 context tokens,
authenticated starting sessions. This is a small exploratory study, not an
uplift estimate. Earlier runs are retained separately: onboarding/model pilots
and a collection-scope mismatch discovered when task-family variants changed
libraries. No test-normal/test-challenge answers, traces or evaluator details
were inspected.

## Question

Does access to Relate improve an agent's ability to complete application tasks,
and which parts of its interface deserve development next?

This is an AppWorld-based interface experiment, not a standard leaderboard
submission. Domain adapters add predefined API compositions, which differ from
AppWorld's agent-development rules. The original task evaluator remains the
outcome measure. Neither the agent nor graph builder may read private databases,
solutions, ground-truth answers or evaluator assertions.

## Comparisons

1. Original API/code interface.
2. Original interface plus static relationship documentation.
3. Original interface plus a bulk-read snapshot (same acquisition as graph).
4. Original interface plus Relate reads/traversal with full field evidence.
5. The same Relate interface with compact evidence and selectable fields.

The bulk-read control separates acquisition convenience from graph execution.
All conditions retain original action APIs. All source calls, including calls
inside adapters, count toward cost. Adapter initialization is measured
separately. The same task starts with fresh application state and a fresh Relate
runtime.

## Original stages and scope adjustment

The initial plan below included repeated development-set runs. Local capability
pilots, authentication issues and a task-scope mismatch led to a smaller matched
training study instead. Repeated development-set evaluation remains future work;
it is not represented as completed evidence.

- Install and pin AppWorld; verify a training world and the evaluator.
- Develop adapters and investigate interface costs using training tasks only.
- Freeze interface configurations before a development-set comparison. Record
  any later changes as a separate experiment, without silently replacing runs.
- Run repeated paired model trials subject to the owner's provider and budget.
- Analyze successes, failures, graph uptake, output size, underlying source
  calls, and token use. Report denominators and uncertainty, including negative
  results.
- Preserve reproducible commands, aggregate evidence and a development-oriented
  report in a pull request. Keep protected task data/trajectories local or
  encrypted.

Test-normal and test-challenge are reserved. Development results support
iteration, not a held-out benchmark or a general claim that graphs improve all
agents.

## Hypotheses

- Explicit relationships reduce manual identifier matching and repeated
  discovery.
- Full field evidence may dominate output tokens on collections; a compact view
  may retain decision-relevant status without repeating transport metadata.
- Adoption/discovery and collection completeness may matter more than traversal
  syntax. Empty observed relationships must not imply an empty source
  collection.
- Source identifiers must remain usable by original action tools even when reads
  return canonical graph identifiers.
- A useful graph may require many-to-many junctions and cross-system identity
  resolution that a one-to-one foreign-key example does not expose.

## Sources

- [EvoOntology](https://arxiv.org/abs/2609.15779)
- [AppWorld code and protocol](https://github.com/StonyBrookNLP/appworld)
- [AppWorld paper](https://arxiv.org/abs/2407.18901)

AppWorld installed package: `0.1.3.post1`; Python: `3.11.6`. Relate starting
revision: `a043f59`.
