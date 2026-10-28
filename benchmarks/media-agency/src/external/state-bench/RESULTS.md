# Current results — incomplete comparison

Luna, medium reasoning, one run of each domain's complete 50-task test split.
Original task/state and UX graders use GPT-5.4 over OpenAI transport.

| Direct-tool baseline | Passed | Task success | Mean UX / 5 | Observed agent cost |
| --- | ---: | ---: | ---: | ---: |
| Customer support | 24 / 50 | 48% | 3.4296 | $0.069144 |
| Travel | 28 / 50 | 56% | 3.5604 | $0.081374 |
| Shopping | 23 / 50 | 46% | 3.5634 | $0.035013 |
| Total | 75 / 150 | 50% | — | $0.185531 |

All 150 baseline trials were scored. These are single-run observations, not
the official five-run reliability metrics. Costs are observed agent-only
estimates; simulator/judge usage and any unreported failed-request usage are
excluded. Total experiment spend is unknown.

The per-task outcomes, manifests and trajectory hashes are in `results/`.
Raw trajectories and model traces remain in
`benchmarks/media-agency/artifacts/state-bench/*-baseline-001/`.

Relate attempt 001 partially ran, then Docker became unresponsive when the
TheAgentCompany services started alongside twelve executors. We stopped the
three domain processes, retained incomplete summaries and raw attempts, and
recorded an infrastructure note. Their scores cannot support a clean comparison.
Attempt `relate-clean-002` reduced global concurrency to two executors and ran
domains sequentially, but encountered OpenAI `credit_balance_exhausted`.
No completed Relate comparison is available yet. Neither incomplete attempt is
silently replaced by a later run.

The next run must use a new output directory after credits are restored, with
the workplace services stopped. `suite.py --arm relate --workers 2` covers all
three test domains and stops scheduling on a confirmed credit-exhaustion error.
