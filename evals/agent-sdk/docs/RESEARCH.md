# Research and framework decision

Reviewed 22 October 2026. Sources below are primary documentation and the actual
Relate research branches. Framework recommendations are our engineering
judgment, not claims of measured superiority.

## Existing Relate research

| Source inspected                                                                                                                 | Useful evidence                                                                                                                                     | Applied here                                                                                                             |
| -------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| [PR #14](https://github.com/relatehq/relate/pull/14), head `af0650d`, `sdk_runner.py`, `harness_protocol.py`, architecture guide | AppWorld comparison with retained trajectories; separate application-state/completion failures; readback, pagination and cut-off discovery failures | Independent final-state grading, explicit submission, output truncation marker, native write/retry tasks, frozen sources |
| [PR #19](https://github.com/relatehq/relate/pull/19), head `20288e5`, `desk.ts`, `goals.ts`, `repl.ts`, `child.ts`               | Seven discovery-only goals; TypeScript notebook; top-level redeclarations; before/after SDK comparisons                                             | Start with progressive discovery, preserve notebook variables, cover reference/traversal/cursor/error recovery           |

These PRs remain unchanged. Their historical results are not imported into this
suite. The new fixture, task IDs and scores have their own version. The notebook
follows the earlier probe's TypeScript/Node REPL pattern; the runtime and
graders now live outside its code-execution process.

## Framework comparison

| Framework  | Concrete integration shape                                                  | Fit and decision                                                                                                                                                                                                                                                        |
| ---------- | --------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Inspect AI | `Task(dataset, solver, scorer)`; `@tool execute_code`; replaceable `Solver` | Selected. Task lifecycle, provider integrations, repeated epochs, budgets, structured logs and viewer are already available. Python adds a language boundary, but only the Relate adapter is custom.                                                                    |
| Harbor     | `instruction.md`, `task.toml`, `environment/`, `tests/`, `solution/`        | Strong choice for terminal/coding agents and portable sandbox tasks. Prefer it if a future suite focuses on building Relate applications with coding CLIs. Our immediate consumer task needs an authenticated live SDK session, which maps directly to an Inspect tool. |
| Promptfoo  | JavaScript provider `callApi()` plus output assertions                      | Good JavaScript-native model/prompt matrices and assertions, including agent providers. We would still need to own this persistent world's lifecycle and state scoring. Inspect's solver/task separation better matches the initial scope.                              |

Sources: [Inspect tasks and solvers](https://inspect.aisi.org.uk/solvers.html),
[Inspect agents](https://inspect.aisi.org.uk/agents.html),
[model providers](https://inspect.aisi.org.uk/providers.html),
[log viewer](https://inspect.aisi.org.uk/log-viewer.html),
[Harbor task format](https://docs.harborframework.com/tasks/overview),
[Harbor agent integrations](https://docs.harborframework.com/agents/pre-integrated-agents),
[Promptfoo custom providers](https://www.promptfoo.dev/docs/providers/custom-api/),
[Promptfoo assertions](https://www.promptfoo.dev/docs/configuration/expected-outputs/).
The installed Inspect version and all transitive dependencies are frozen in
`uv.lock`; the actual adapter was validated against that implementation.

## Evaluation practices adopted

[Anthropic's agent-evaluation guide](https://www.anthropic.com/research/demystifying-evals-for-ai-agents)
distinguishes tasks, trials, graders, transcripts and actual outcomes. Its
practical consequences here are multiple attempts, observable state checks,
retained trajectories, and separate capability/reliability measurements. We use
deterministic graders wherever the outcome is exact, and reference solutions to
check that the benchmark is solvable. There is no model judge in the success
path. A model's claim to have written a note cannot substitute for the note.

Inspect supports [sandboxed tools](https://inspect.aisi.org.uk/sandboxing.html),
[limits](https://inspect.aisi.org.uk/limits.html), and
[evaluation sets](https://inspect.aisi.org.uk/eval-sets.html). We use its task,
solver, tool, scoring and log machinery. The local adapter owns Docker directly
because it needs a persistent bidirectional notebook and a separate trusted
runtime. This is extra code with explicit lifecycle/isolation tests, not a new
provider SDK or general evaluation runner. The CLI uses fresh immutable runs; it
deliberately does not enable eval-set's automatic retry/cleanup behavior.

## Interpretation and next additions

- Difficulty levels are author-assigned complexity categories, not calibrated
  psychometric difficulty. Report each family, not only the pooled score.
- Model, prompt, solver, SDK, limits and fixture revision all belong to the
  evaluated agent configuration. Change one at a time for an intervention study.
- The live smoke demonstrates wiring and retention. It does not establish a
  model ranking; run a broader predeclared matrix for that question.
- More domains, independently authored tasks, real connector sandboxes and
  separate graph-authoring tasks would improve external validity. Add them as
  explicit environment/task versions, keeping old results immutable.
- A capability failure stays a failure. Provider/environment errors remain
  separately visible and in the planned denominator. Fixing an error creates a
  new attempt rather than overwriting history.
