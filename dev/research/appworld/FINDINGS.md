# What to develop next from the AppWorld experiment

> These are the original Ollama/wrapper findings. The subsequent direct-SDK
> TypeScript experiment is reported separately in [SDK-STUDY.md](SDK-STUDY.md).

The useful question is which work the graph removes from an agent. This study
separates semantic notes, bulk acquisition, Relate execution and evidence
presentation. It uses local Ollama models and real Relate reads/traversals.
There is no production API change in this PR.

## Scope and controls

The primary run, `covered-v1`, uses two read-only training cases selected for
exact adapter coverage: playlist-duration aggregation and contact/payment
aggregation. Each runs with raw APIs, static semantic notes, normalized bulk
reads, full Relate results and compact Relate results. Qwen 3.6 27B uses seed
11, temperature 0.2, thinking disabled, a 16,384-token context and at most 14
turns. Every condition starts with the same four host-authentication calls.
Original APIs remain available. World state and the graph reset between
episodes.

This is an **AppWorld-based interface experiment**, not a leaderboard score or a
reproduction of [EvoOntology](https://arxiv.org/abs/2609.15779). Predefined API
compositions and authenticated starts change AppWorld's standard protocol.
Neither acquisition nor agent execution reads the evaluator or private database.
The unchanged AppWorld evaluator is called after the agent finishes. These are
exploratory training cases, not a random or held-out sample. No test-normal or
test-challenge tasks were used. A single seed cannot establish reliability.

The flat control shares normalized records, source acquisition and identifier
construction with the graph conditions. It bypasses Relate get/traverse while
retaining the same bulk convenience. It does not remove every semantic-model
choice; raw APIs are the no-graph baseline.

## Primary outcomes

All ten scheduled episodes finished without infrastructure errors. Raw APIs
passed one of two tasks; all other conditions passed both. Two cases are too few
to estimate general accuracy or attribute success to the graph: static notes
alone also fixed the one raw failure.

| Task scope | Condition | Pass | Turns | Prompt tokens | Generated tokens | App calls | All agent API calls |
| ---------- | --------- | ---- | ----: | ------------: | ---------------: | --------: | ------------------: |
| Playlists  | raw       | yes  |     9 |        37,880 |            1,021 |        31 |                  36 |
| Playlists  | static    | yes  |     9 |        38,909 |            1,263 |        31 |                  36 |
| Playlists  | flat      | yes  |     7 |        28,722 |              638 |        29 |                  30 |
| Playlists  | full      | yes  |     7 |        15,563 |            1,598 |        29 |                  30 |
| Playlists  | compact   | yes  |     4 |         5,794 |              726 |        29 |                  30 |
| Payments   | raw       | no   |    14 |        72,193 |            1,909 |        19 |                  24 |
| Payments   | static    | yes  |    11 |        48,397 |            1,203 |         9 |                  15 |
| Payments   | flat      | yes  |     7 |        21,203 |            2,141 |        26 |                  27 |
| Payments   | full      | yes  |     7 |        38,104 |            1,364 |        13 |                  14 |
| Payments   | compact   | yes  |     5 |        31,483 |              724 |        13 |                  14 |

App calls exclude documentation, supervisor calls and the four common setup
calls. All agent API calls include documentation and task completion, including
calls inside acquisition. Prompt tokens sum per-turn counts, including history;
they are not unique tokens or billing estimates. Condition order rotated across
the two tasks. No latency comparison is claimed.

The raw payment failure was semantic: the agent searched Venmo users/friends for
the word "roommate" and treated those search hits as the target group. It never
obtained the phone contact relationship labels. Static notes named that
cross-app relationship and the static trial passed. This supports making the
business meaning discoverable, but does not establish that graph execution was
necessary for correctness.

Both graph conditions successfully used traversal on both tasks. Compact results
used fewer turns than full results (4 vs 7 for playlists, 5 vs 7 for payments),
but the full playlist run spent turns recovering from an ID mistake. The flat
condition also passed both tasks. These paths do not isolate graph structure
from response presentation and prompt affordances.

For payments, static notes used nine application calls; a single graph snapshot
used 13. Flat used 26 because it reloaded. Thus a graph can reduce agent turns
while increasing source work. For playlists, bulk/full/compact each used 29
application calls versus 31 for raw/static.

## Response size is a concrete interface cost

A scripted public-API probe acquired 57 songs, eight playlists and 60 membership
objects with 59 source calls. This is an adapter probe, not a model task result.
Serialized song-list sizes were:

| Representation          | All fields, bytes | Three selected fields, bytes |
| ----------------------- | ----------------: | ---------------------------: |
| Flat normalized records |            19,302 |                        7,650 |
| Full Relate evidence    |           185,742 |                       65,562 |
| Compact Relate evidence |            22,266 |                       10,614 |

The three selected fields were `sourceId`, `title` and `likeCount`. Compact
all-field output is 8.34 times smaller than full output in this probe; compact
projection is 17.50 times smaller than full all-field output. Synthetic scaling
from 10 to 500 records confirms that repeated evidence grows with collection
size, rather than being a single fixed wrapper cost.

The full condition preserves per-object runtime evidence. The adapter owns
collection enumeration and combines traversal pages; it does not preserve every
original page-level metadata field. This is not a transport-conformance test.

Bytes are not tokens or model success. The agent has a persistent Python
interpreter and can aggregate a large result without printing it. Accordingly,
the trajectory analysis distinguishes bytes returned by the helper from text
actually exposed to the model. Full evidence can be cheap in model context when
the agent computes a summary before printing; compact output can still be too
large when it prints entire collections.

The experimental compact renderer retains values, completeness/degradation and
exceptional field states. It has synthetic checks for stale, forbidden and
unavailable values, but is **not a complete production evidence contract**: a
production projection must also audit warnings, ordering, durability and
provenance requirements and offer a path to detailed evidence. We did not test
agent behavior under injected source denial or staleness.

## Adapter affordances can dominate graph reasoning

The flat payment trajectory initially read the wrong result-envelope level, then
reloaded data it already had. Both flat and full payment trajectories initially
treated canonical sender/receiver references as email source IDs. These are
interface-usability failures in our experimental adapter and prompt, not
evidence of incorrect Relate joins. The agent recovered by inspecting the result
shape.

The adapter has inconsistent envelopes: `load` returns counts directly while
reads return a `result` wrapper. It also documents traversal in a shared prompt
and then disables it for the flat control. The flat playlist agent attempted the
unavailable operation once before switching to a Python join. Those confounds
remain in the frozen primary run and limit causal comparisons. A next scaffold
should use one result envelope, condition-specific tool documentation and a
short example mapping source IDs to canonical references, then rerun every
condition rather than comparing a repaired condition against these results.

## Prompt-only follow-up: a mixed result

After reading the primary traces, `interface-docs-v2` reran the payment task
with flat and compact access using `--clarify-interface`. The same model, seed,
world and budgets were used. The added prompt explains load/read envelopes and
canonical references with an identity-map example; the flat prompt omits
unavailable traversal documentation. No acquisition or graph behavior changed.

| Condition | Pass | Turns | Prompt tokens | Generated tokens | Agent API calls | Snapshot loads |
| --------- | ---- | ----: | ------------: | ---------------: | --------------: | -------------: |
| flat      | yes  |     8 |        28,164 |            1,426 |              14 |              1 |
| compact   | yes  |     4 |         7,480 |              787 |              14 |              1 |

Flat stopped reloading the snapshot: API calls fell from 27 to 14, but turns
rose from seven to eight. It copied the example's `select=['sourceId']` and then
expected relationship labels it had not requested. It recovered by widening the
selection. This shows how a helpful identity example can anchor an agent on an
incomplete projection. The final flat run made 241 helper calls, mostly local
reads; API-call savings do not mean every kind of work decreased.

Compact passed in four turns rather than five, with 7,480 rather than 31,483
summed prompt tokens and the same 14 API calls. It still used traversal. These
are two post-hoc trajectories, not a replicated causal estimate. The prompt
bundle changes multiple things at once; the runs support investigating clearer
contracts, not claiming that every added example improves an agent.

## Collection coverage is different from field completeness

A direct runtime regression creates a source membership without adopting it.
Traversal returns an empty, exhausted observed set. After adoption, the same
relationship returns the membership. This is correct for traversal over adopted
objects; it cannot prove there are no undiscovered records in the provider.

The adapter therefore reads through a terminal empty source page, rejects a
bounded scan that cannot prove completion and reports
`coverage: 'loaded snapshot only'`. It rejects an unloaded domain instead of
returning a convincing empty list. Collection coverage also needs a source
predicate: own transactions are different from a social feed, and playlists are
different from a song library.

For an agent-facing discovery/query API, expose collection scope explicitly. The
proposed contract in [INTERFACE-NOTES.md](INTERFACE-NOTES.md) is a design
sketch, not an implemented public API. Keep this separate from field evidence.

## Acquisition and identity are doing real work

The static payment agent used `search_contacts(relationship='roommate')` and
`show_transactions(direction='sent', min_created_at=..., user_email=...)`. Those
provider filters avoid acquiring every contact and transaction. Our eager
snapshot has no equivalent query pushdown. A lower agent-turn count therefore
does not imply less provider work. Compare application calls separately from
API-documentation calls before claiming acquisition savings.

The payment adapter joins phone contacts to transaction participants using exact
email and creates directional references. That is application preprocessing, not
Relate-native multi-source enrichment. A synthetic test uses two people with the
same display name to check that name matching cannot silently replace the
identity rule. Real connectors need account namespaces, conflict handling and
provenance for these links.

The music adapter uses `Playlist <- Membership -> Song` junctions. Relate's
actual reference-backed traversal works with this model. Array-valued source
properties were not supported by this compiler path, so artist lists and contact
labels are JSON strings. That workaround loses structured field semantics and
should not become a public authoring recommendation.

Source IDs remain available as `sourceId` so a read can feed an original action
API. Canonical IDs remain typed by object definition in the runtime. Accepting
both forms is adapter behavior, not a change to Relate's identity contract. The
full-evidence music agent initially constructed a membership source ID from a
source playlist ID and a canonical song ID. The runtime rejected it with
`Unknown root ID`; the agent then inspected and used the returned membership ID.
This is concrete evidence that presenting both ID namespaces needs clearer
examples. Prefer passing returned opaque IDs, and expose source IDs explicitly
only at the original-tool boundary.

## What the pilots taught us

Earlier runs are retained separately, including interrupted runs; they are not
pooled into the primary comparison.

- Qwen 3 8B failed both raw and compact pilots with thinking disabled. One run
  invented data after an initialization error; the other repeated failed
  authentication. That reveals a capability floor for this scaffold, not a graph
  effect. We did not establish that the model cannot work with a better prompt
  or thinking enabled.
- Gemma 4 attempts failed before agent execution when the local server
  disconnected. A GPT-OSS model inspection failed with a tensor-size error.
  These are environment compatibility observations, not task-accuracy failures.
- Qwen 3.6 27B completed initial raw and compact pilots. It became the primary
  model. Ollama restarted from 0.34.2 to 0.40.1 during setup; the primary run
  uses 0.40.1. Model digests and configurations are retained with the evidence.
- The end-to-end raw pilot took 13 turns on a music-library task; the later
  authenticated raw pilot took five. The intervention included both host login
  and clearer interpreter instructions, so the difference cannot be attributed
  solely to authentication. Treat host credentials as an explicit benchmark
  boundary, not free agent competence.
- A task-family variant selected for the first authenticated comparison used an
  album/song library outside the playlist adapter's scope. The flat agent
  correctly ignored the helper. This sampling mistake was discovered after
  execution began; that run was stopped and retained. The matched comparison
  uses an explicitly playlist-scoped case. Task-family IDs alone are not a
  sufficient coverage filter.

Mac power changed from battery to AC during the primary music/static episode.
Timing is diagnostic only: there is no latency or throughput speedup claim.

## Development priorities

1. **Make meaning and identity explicit at the agent boundary.** Describe where
   business labels live and show canonical references separately from source
   identifiers. Use consistent envelopes and condition-specific capabilities.
   Keep examples broad enough to explain field projection instead of anchoring
   the agent on one incomplete selection.
2. **Add source discovery/query with a coverage contract.** Traversal over
   adopted objects works, but collection completeness needs a predicate and an
   acquisition guarantee. Push useful filters toward providers rather than
   making every task load a whole account.
3. **Design an agent evidence view with projection and detail access.** The
   measured byte reduction is substantial. Preserve exceptional states and audit
   every omitted warning/provenance field before production adoption. Larger
   collections still need filtering or in-process aggregation.
4. **Keep the flat baseline and broaden the evaluation before evolution.** A
   graph-only before/after would credit normalization, authentication and prompt
   improvements to graph execution. Include these controls when testing future
   changes; add permissions, freshness and actions as separate evaluated paths.

No new public `query`, projection transport or identity-resolution API is
implemented here. [INTERFACE-NOTES.md](INTERFACE-NOTES.md) gives concrete
contract sketches and names the adapter-owned behavior.

## Reproducibility and next experiment

See [README.md](README.md) for commands, [PLAN.md](PLAN.md) for hypotheses and
[BENCHMARKS.md](BENCHMARKS.md) for alternatives. Public evidence contains
metrics, configuration and trace hashes, not task text, answers or individual
records. Protected traces and frozen source snapshots are distributed in
AppWorld's bundle format; unpack locally for inspection.

Before making an uplift claim, freeze the interface and select a broader sample
by declared source scope, including tasks where bulk loading is wasteful. Run
paired repetitions with fixed local model/runtime versions and retain failures.
Include flat normalization as a control, measure actual traversal uptake and
source calls, and add an injected incomplete/denied-source suite. Only after
that should automatic ontology edits be evaluated on a separate held-out set.
