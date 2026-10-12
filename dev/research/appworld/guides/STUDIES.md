# Retained studies

Read each result with its own protocol, source revision, task set, and controls.
The sequence below runs from oldest to newest. "Current", "next", and promotion
recommendations inside historical reports refer to the state at that study's
freeze. They are not a backlog or a statement about today's SDK.

| Study                                  | Report and protocol                                                                                             | What it establishes                                                                                                                              |
| -------------------------------------- | --------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| Original local-model interface study   | [Findings](../FINDINGS.md), [plan](../PLAN.md), [benchmark choice](../BENCHMARKS.md), [reproduction](OLLAMA.md) | Ollama comparisons of original APIs, static notes, bulk snapshots, and experimental graph/evidence projection; superseded pilots remain retained |
| Initial direct-SDK study               | [SDK study](../SDK-STUDY.md)                                                                                    | Actual public SDK in a persistent TypeScript REPL; includes mixed API access and diagnostic protocol revisions                                   |
| Nano SDK rerun                         | [Results](../SDK-NANO-RERUN.md), [plan](../SDK-RERUN-PLAN.md)                                                   | Historical mixed SDK/API condition; cannot be labeled SDK-only                                                                                   |
| Uniform four-interface read comparison | [Results](../TS-COMPARISON.md), [plan](../TS-COMPARISON-PLAN.md)                                                | Original Python, static notes, raw TypeScript, and SDK-only conditions; 72 episodes                                                              |
| First write-action pilot               | [Results](../WRITE-PILOT.md), [plan](../WRITE-PILOT-PLAN.md)                                                    | Venmo likes/comments, readback, and the resolved VM-realm blocker; 24 episodes                                                                   |
| Turn-budget comparison                 | [Results](../WRITE-BUDGET.md), [plan](../WRITE-BUDGET-PLAN.md)                                                  | 14 versus 28 turns with retained prompts; fresh trajectories are not a pure causal cost comparison                                               |
| Explicit no-answer completion          | [Results](../COMPLETION.md), [plan](../COMPLETION-PLAN.md)                                                      | Completion guidance added once per prompt; historical static-note arm retired from subsequent comparisons                                        |
| Explicit contact graph                 | [Results](../GRAPH-SHAPE.md), [plan](../GRAPH-SHAPE-PLAN.md)                                                    | Owner-scoped labels and field meanings with unchanged SDK/prompts                                                                                |
| Main queries and expanded subset       | [Results](../QUERIES.md), [plan](../QUERIES-PLAN.md)                                                            | Six-task comparison after main's query/consumer changes; original subset separated from added tasks                                              |
| Independent ergonomics treatments      | [Results](../ERGONOMICS.md), [plan](../ERGONOMICS-PLAN.md)                                                      | 120 episodes with fresh controls; only contact-description treatment confirmed, 18/24 versus 16/24                                               |
| Explainer candidate/control studies    | [Results](../EXPLAINER-RESULTS.md), [frozen branches](../EXPLAINER-STATUS.md), [plan](../EXPLAINER-PLAN.md)     | 336 episodes across screening, confirmation, and holdout; datetime was promoted separately; negative candidates retained                         |
| Two-model single-pass evaluation       | [Results and protocol](../TWO-MODEL.md)                                                                         | Original 12 instances, two models, four interfaces, 96 attempts; separate saved-library/contact-group follow-ups                                 |
| Expanded single-app families           | [Results and protocol](../EXPANDED-FAMILIES.md)                                                                 | 69 additional instances, Haiku, raw Python versus SDK, 138 attempts at `8a14a4e`; subsequent offline fixes do not replace scores                 |

[Interface observations](../INTERFACE-NOTES.md) are design observations from the
original experiment, not a portable API specification.
[Prompt provenance](../PROMPT-PROVENANCE.md) records instruction sources and
intentional changes. [Write recovery](../WRITE_RECOVERY.md) documents the
implemented adapter contract. The [coverage guide](COVERAGE.md) owns today's
supported families and data scope.

## Reproduction is revision-specific

Use a report's frozen commit and retained `source/` snapshots to reconstruct its
execution. New runs need unique names and do not overwrite original attempts.
Candidate SDK branches and their build hashes belong to their experiment;
`explainer_experiments.py` prepares worktrees and can change their local support
files. Do not run it as a generic validation command for this cleanup.

Historical validators intentionally encode the run matrices, denominators, and
artifact layout of their study. They are not interchangeable with
`audit_two_model.py`, which audits newer single-pass batch manifests. Similarly,
`explorer.py` and `results_explorer.py` serve different artifact formats.

## Current follow-up status

Personal ratings and per-cell Node quota reset were implemented after the frozen
expanded batch and validated offline. Pagination/discovery presentation,
readback efficiency, error recovery, and separate completion reporting remain
listed in the
[expanded-study checklist](../EXPANDED-FAMILIES.md#follow-up-checklist). They
require explicit implementation and a separately frozen evaluation before
claiming improvement. Merge cleanup changes navigation and ownership, not those
experimental behaviors.
