# Explainer proposals: independent follow-up experiments

Frozen before the first new model episode, 2026-10-11.

Base: main 2cf7f92 plus PR 24 operation identity 06f6032, held constant.
Research integration: PR 14 59fb67c, including contact descriptions and durable
write recovery. Historical runs are context only, never the new control.

Evaluate the six explainer directions separately: structured action outcome
discovery; bounded structured action/read diagnostics; explicit
page()/records(); local-datetime schema/ranges; relationship predicate discovery
and separately traversal filtering; host-supported acquisition coverage. Also
assess snapshot TypeScript control feasibility without presenting raw-API
comparisons as causal SDK uplift. Correctness and non-disclosure gates precede
each model arm.

Same six training tasks and harness budgets as ERGONOMICS-PLAN: nano low, 28
turns, 4096 output/request, 14000 generated/episode, 14000 output characters,
world seed 100. Two repeats per screening arm. Identical prompts, REPL, acquired
records, action recovery and execution permissions. Temporal adoption and
coverage evidence require named graph/integration changes, recorded explicitly.
No public benchmark contents or credentials. Preserve every attempt and frozen
source hashes, exact SDK patch and build identity. Run arm names are unique.

Promotion rule: more official passes, or equal passes with >=10% fewer mean
turns or input tokens and <=10% regression in the other measure. Qualifying arms
require two further repeats against a fresh control, then unseen train/dev
instances from the same task families; retain no accuracy regression in either
confirmation or holdout. Report small samples and multiple comparisons. A
correctness fix can qualify independently with deterministic reproduction but
must not be described as measured agent uplift. No combined treatment before
individual testing. Maximum new batch model estimate $5; preserve attempted
spend and incomplete episodes. Do not silently switch models or retry failed
model calls. Only supported SDK improvements get a PR targeting main;
prerequisite PR 24 must remain explicit while unmerged.

## Implementation checkpoint amendment, before resumed evaluation

On the owner's instruction to implement every suggestion for later evaluation,
all seven SDK candidates and the snapshot read control were completed in
separate local checkouts. The common harness now also supports the plain-array
condition and records host preparation fetches. SDK prompts and the existing
REPL lexical semantics remain unchanged. Local datetime and coverage have
explicit graph variants; all other candidate graphs match the control
byte-for-byte. Every new online comparison must use this prepared harness and
fresh controls, not the TLS-blocked attempts. Pair contemporary controls with
each candidate and rotate arm order as implemented in
`explainer_experiments.py`.

The snapshot control isolates read/query operations only: it shares normalized
records, descriptions, evidence and the SDK-backed write adapter. Its eager
array materialization is included in setup measurements. It is not a pure
raw-API or SDK-free write baseline. Host acquisition coverage is a trusted
integration claim with a current authorization check; it does not add provider
scanning/pushdown. The temporal experiment explicitly adopts second-precision
local wall times in the research graph, never inferred UTC instants. Holdout
selection must exclude screening instances, remain within train/dev and be
frozen before outcome review.
