# Evidence index

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
