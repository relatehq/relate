# Implementation validation — 2026-10-28

These are deterministic reference-solution checks, **not model performance
results**. No paid model runs were made in this initial validation snapshot.

**Historical limitation found in the fix round:** the initial CLI/reference
runner logged configured faults without forwarding them to the environment. Its
`action.create-2` checks did not inject response loss. Direct simulator and
integration tests did inject it. These original checks and `validation.json`
remain unchanged; new runner regressions and the fix-round evidence verify the
corrected path. See the
[first fix-round report](results/2026-10-28-luna-round1.md) for the new 396/396
reference checks, six observed faults, 35 benchmark tests and full repository
validation.

| Check                           | Result                                                                                               |
| ------------------------------- | ---------------------------------------------------------------------------------------------------- |
| Full catalogue, tier S, seed 7  | 198/198 runnable checks passed across three arms; 42 deferred records                                |
| Full catalogue, tier S, seed 19 | 198/198 runnable checks passed across three arms; 42 deferred records                                |
| Benchmark tests                 | 17 passed                                                                                            |
| `pnpm check`                    | 3,120 passed, 10 skipped; format, lint, types, boundaries, Postgres integration and packaging passed |
| Tier M generation, seed 19      | 1,432,000 loaded ad rows; 71,600 campaign-day rows; 819 FX rows; 48,000 safety events                |
| Tier L generation, seed 19      | 5,370,000 loaded ad rows; 268,500 campaign-day rows; 819 FX rows; 180,000 safety events              |

The 42 deferred records per seed are the same 14 FX/rebalancing tasks in each of
three arms. They are not executions, failures or passes. The 20 pilot tasks are
included in the full catalogue check. M/L validation checks generation and SQL
projections only; it does not claim that the full reference matrix or model
matrix ran at those tiers.

Reproduce the reference checks from the repository root:

```sh
pnpm bench:agency:validate --stage main --seed 7 --out benchmarks/media-agency/artifacts/reproduce-s7
pnpm bench:agency:validate --stage main --seed 19 --out benchmarks/media-agency/artifacts/reproduce-s19
pnpm bench:agency:report --out benchmarks/media-agency/artifacts/reproduce-s7
pnpm bench:agency:report --out benchmarks/media-agency/artifacts/reproduce-s19
pnpm check
```

`validation.json` records the exact source revision hashes and manifest IDs for
these checks. Raw transcripts/results and the failed development attempts remain
in the implementation worktree's ignored `artifacts/` directory. They are not
published model-evaluation evidence. The checked-in generator, reference
programs and seeds reproduce the checks without an API key.

## Step telemetry validation

The telemetry update passed **40 benchmark tests** and the full `pnpm check`
(**3,143 tests passed, 10 skipped**, including Postgres and installed-package
checks). Scripted OpenAI/Anthropic responses verify per-call usage/cost, request
IDs, header filtering, errors, aborts and timing totals without a paid rerun.

A fresh reference pilot passed **60/60** (20 tasks × three arms, S, seed 7),
including three observed response-loss faults. Its **63,769 spans** have
matching starts/ends, valid parent IDs, nonnegative durations, sequential
events, and exact event/byte accounting. The reporter finds no unfinished spans
or malformed lines. The original fix-round Luna artifacts read as 60 legacy
transcripts with no fabricated step timings.

[Telemetry evidence and source revision](results/2026-10-28-telemetry-validation.json)
records the manifest/report hashes. Raw logs remain under
`artifacts/telemetry-reference-s7`. These are instrumentation correctness
checks, not a new model-performance or instrumentation-overhead measurement. See
[telemetry fields and measurement limits](TELEMETRY.md).
