# Prompt provenance and controlled differences

The new `prompts.py` is a uniform, zero-shot adaptation of AppWorld's
[ReAct-code instructions](https://github.com/StonyBrookNLP/appworld/blob/42b5bcf3cd334fee33f0c37c02070a9f5807add5/experiments/prompts/react_code_agent/instructions.txt),
inspected on 2026-10-09. Pinned upstream commit:
`42b5bcf3cd334fee33f0c37c02070a9f5807add5`. Source file SHA-256:
`c41f7852217d46586047a38f68e88b827cb9dcbe624e9651f9db8301547a534b`. The upstream
project is Apache-2.0 licensed. The instructions are paraphrased and adapted
here; this is not a verbatim reproduction of the full upstream agent or prompt.

## Preserved guidance

All conditions share autonomous task execution, retrieving real values, no
placeholders, valid choices for unspecified details, avoiding collateral
changes, interpreting personal relationships through phone contacts, time
boundaries and the default time zone, simulated rather than host file access,
reading operation specifications, processing pagination, and minimal answers
submitted through the completion operation. The installed AppWorld API supports
explicit failure status; all conditions can submit it.

## Necessary environment substitutions

| Upstream surface                            | This experiment                                                                                                                  |
| ------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| Python code blocks in a ReAct conversation  | One `execute_code` function call per turn; Python or TypeScript according to condition                                           |
| Login and credential retrieval by the agent | Common host authentication, with source tokens exposed only in original-API conditions; no contradictory request to log in       |
| Python execution                            | Original Python for controls, the same persistent Node worker for raw TS and SDK; explicit existing-object and persistence rules |
| API discovery                               | Original three discovery entry points in API arms, actual `relate.describe()` and object discovery in SDK arm                    |
| Current time from Python/phone              | Simulator date/time supplied in every task message, avoiding Node's real host clock                                              |
| Original completion API                     | Original call in Python; the same narrow `completeTask` host capability in both Node arms                                        |

TypeScript API examples translate keyword arguments to a named-argument object
and await the result. They preserve original operation names, JSON response
shapes and manual pagination. They introduce no automatic acquisition,
normalization, SDK query syntax or pagination helper.

The SDK prompt contains no domain schema, relationship names or task-specific
examples. Only `static` receives the existing relationship-note ablation.

## Deliberate departures, not claims of exact benchmark parity

- The upstream file contains a full worked playlist-count/login conversation. We
  retain the study's zero-shot protocol and omit that demonstration in every
  arm. A direct port would teach a music workflow and conflict with host login;
  an SDK translation would additionally prescribe domain-specific operations.
- Common instructions remain in one system message, per the requested setup,
  rather than the upstream alternating user/assistant prompt transcript.
- The original model tool protocol, 14-turn budget, authentication, acquired
  graph coverage and evaluator remain this project's controlled research setup.
- Native Python and Node printing/errors still differ; raw TS versus SDK is the
  comparison that holds the Node execution environment constant.

Removed from the old custom prompt: the conflicting login instruction, the extra
“one short cell” ending, and repeated completion feedback. We do not add an
anti-no-op rule, a task-solving algorithm, or a task-specific answer hint.

## Explicit no-answer experiment

`sdk-nano-no-answer-v1` adds the no-argument completion example once in the
system prompt for all three retained methods: `apis.supervisor.complete_task()`
in Python and `await completeTask()` in both Node environments. Static notes are
retired from future comparisons; their implementation is retained solely for
historical reproducibility. The prompt contains no new solving strategy.
