# Evidence index

These are retained outputs, not generated fixtures to refresh during cleanup.
Study protocols and interpretation live in the
[study index](../guides/STUDIES.md). The
[development guide](../guides/DEVELOPMENT.md) explains archive restoration.

## Study ownership

| Evidence files                                                                                                                             | Owning study                                                                                 |
| ------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------- |
| `summary.json`, environment/model/power observations, probes/scaling, `validation.json`, `archive-verification.json`, `followup-plan.json` | [Original Ollama study](../FINDINGS.md)                                                      |
| `sdk-summary.json`, `sdk-diagnostics.json`, `sdk-trace-audit.json`, `sdk-validation.json`                                                  | [Direct SDK study](../SDK-STUDY.md)                                                          |
| `sdk-nano-*`                                                                                                                               | [Nano rerun](../SDK-NANO-RERUN.md)                                                           |
| `ts-comparison*`                                                                                                                           | [Four-interface read comparison](../TS-COMPARISON.md)                                        |
| `write-pilot*`, `write-budget*`                                                                                                            | [Write pilot](../WRITE-PILOT.md), [turn budget](../WRITE-BUDGET.md)                          |
| `completion*`, `graph-shape*`, `queries*`                                                                                                  | [Completion](../COMPLETION.md), [contact graph](../GRAPH-SHAPE.md), [queries](../QUERIES.md) |
| `ergonomics.json`, `graph-contact-description.patch`, `graph-date-description.patch`                                                       | [Ergonomics treatments](../ERGONOMICS.md)                                                    |
| `explainer-*`                                                                                                                              | [Explainer results](../EXPLAINER-RESULTS.md) and [frozen branches](../EXPLAINER-STATUS.md)   |
| `main-two-model-20261012-*`                                                                                                                | [Two-model evaluation](../TWO-MODEL.md)                                                      |
| `music-libraries-20261012-*`, `contact-groups-20261012-*`, `contact-group-fields-20261012-*`                                               | Separate follow-ups in [TWO-MODEL.md](../TWO-MODEL.md)                                       |
| `expanded-haiku-20261012-*`                                                                                                                | [Expanded-family evaluation and failure analysis](../EXPANDED-FAMILIES.md)                   |
| `task-family-inventory.json`, `expanded-preflight.json`, `expanded-final-preflight.json`, `expanded-validation.json`                       | [Coverage](../guides/COVERAGE.md) and recorded offline adapter validation                    |

`*-results.json` records audited batch attempts; `*-archive.json` records the
matching bundle hash and every restored file hash. `*-failures.json` is derived
analysis, not a replacement score. Validation/preflight reports are offline
checks, not agent results. Source hashes describe the frozen execution, not the
current working tree.

## Protected archives

- `trajectories.bundle`: historical multi-study runs and source snapshots.
  Restore with `archive.py unpack` into `.local/restored/runs`.
- `main-two-model-20261012.bundle`: original 96-attempt batch.
- `music-libraries-20261012.bundle`: saved-library follow-up.
- `contact-groups-20261012.bundle`: contact-group traversal follow-up.
- `contact-group-fields-20261012.bundle`: payment-membership fields follow-up.
- `expanded-haiku-20261012.bundle`: additional 138-attempt batch.

The named batch bundles contain `batch/`, `runs/`, and `world-outputs/` and use
`archive_batch.py` retention. They have a different layout from the historical
archive; do not combine restored directories blindly. Original attempts,
including failures and incomplete episodes, must remain intact.

## Original study evidence and metric definitions

- `followup-plan.json`: post-hoc prompt intervention and its limits.
- `summary.json`: episode metrics, original run configurations, trace hashes and
  explicit completion coverage. Interrupted matrices remain incomplete.
- `environment.json`: local environment and installed model metadata at primary
  study setup. Model names can have more than one backend digest; the primary
  loaded Qwen model used the `llamacpp` digest beginning `8a13c875`.
- `loaded-model.json`: Ollama loaded-model observation during the primary run.
- `power-transition.json`: battery-to-AC transition; timings are diagnostic.
- `probe-results.json`: scripted public-API adapter response-size probe.
- `scaling.json`: synthetic response-size scaling at 10, 100 and 500 songs.
- `archive-verification.json`: bundle hash and restored-file verification.
- `validation.json`: checks completed and their scope.
- `trajectories.bundle`: AppWorld-format encrypted traces, API calls, evaluator
  outputs, run configurations and source snapshots. Restore with `archive.py`.

The plain JSON files contain aggregate/structural measurements, not task
instructions, answers or application records. API calls inside `research.load`
are included in source-call totals. `used_traversal` requires a successful tool
response; `attempted_traversal` also includes rejected operations. A helper
response's bytes do not imply all of that response was printed to model context.
Prompt-token totals include history processed on successive turns.

The historical `source_calls` metric counts all AppWorld API calls, including
login, documentation and supervisor calls; `agent_source_calls` subtracts host
setup. `agent_api_categories` separates application, documentation and
supervisor calls after setup. `research_calls[*].source_calls` counts
acquisition calls inside each helper invocation. These should not be confused
with graph-store reads, model turns or real network requests (AppWorld is a
simulator).

An infrastructure error has null success and is excluded from the valid-task
accuracy denominator. An interrupted episode without `result.json` is absent
from episode results and present in the run's missing-episode list. Do not pool
pilots with the primary matched run, or treat missing episodes as successes or
failures. The protected bundle retains STOPPED notes for superseded studies.
