# Spike validation — 2026-10-22

Local developer-machine evidence, not production capacity or an adoption
decision. Base: `origin/main` at `72d2c3d`. Node 26.9.0, pnpm 12.9.1, Temporal
TypeScript SDK 1.24.0. Downloaded development server reported Temporal CLI 1.9.1
/ Server 1.32.0. Relate uses the worktree's isolated Postgres databases.

| Check                                                               | Observed result                                                                                                                          |
| ------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm check` (sequential final run)                                 | Passed: format, lint, typecheck, boundaries, 187 test files / 2,673 tests passed / 1 skipped, installed-tarball and MCP packaging checks |
| `pnpm install --frozen-lockfile`                                    | Passed, including explicit optional build-script policy                                                                                  |
| `pnpm example:temporal:test`                                        | Passed; real Temporal server, 5 scenarios, enclosing test also counted: 6 passed, 0 failed                                               |
| Final focused rerun after workflow signal/phase cleanup             | Same 6 passed, 0 failed                                                                                                                  |
| `pnpm exec tsc --noEmit -p tsconfig.tests.json`                     | Passed                                                                                                                                   |
| `pnpm exec dotenvx run -f .env -- pnpm test:onboarding`             | 15 passed, 0 skipped                                                                                                                     |
| CLI subprocess smoke with SDK local server                          | `start`, `decide approve`, `result`: approved; second start with same ID rejected; Worker exited on SIGINT                               |
| `pnpm exec vitest run --project unit packages/cli/test/dev.test.ts` | All 12 passed in isolated rerun                                                                                                          |

The machine-readable [scenario results](evidence/scenarios.json) are extracted
from the final experiment's actual output. The test source contains the
assertions and reproduces them; this file is not a substitute for executing the
tests.

## Validation corrections

- Initial install reported `ERR_PNPM_IGNORED_BUILDS` for optional `@swc/core`
  and `protobufjs` postinstall scripts. Explicitly disabled them in workspace
  policy; frozen installation and Temporal bundling passed using the platform
  binary.
- Typechecking caught plain-string IDs at the consumer boundary. Activities now
  parse with public `referenceInput(Request)` before calling typed Relate APIs.
- The boundary check required registering the new example's public imports.
- An initial format check caught the test file; corrected formatting.
- The first full check ran concurrently with onboarding, whose Inspector build
  briefly removes generated assets. Three CLI tests failed with the exact error:

```text
Error: relate dev exited (1) before /Inspector\s+http:\/\/127\.0\.0\.1:\d+\/#token=/:
  error  Inspector assets are missing at /Users/dennis/dev/vs/relate-worktrees/temporal-workflow-poc/apps/inspector/dist/client; build @relate/inspector first
Test Files  1 failed | 186 passed (187)
Tests  3 failed | 2670 passed | 1 skipped (2674)
```

The CLI suite passed alone afterward. Full validation was then rerun without
concurrent onboarding/build commands and passed in full, as recorded in the
table above.

## What these results do not prove

- Forced OS process kill, Temporal service restart, database failover, or a real
  network partition. Restart coverage recreates the Worker and Relate runtime
  within one test process; Temporal stays running.
- Authenticated end-user starts/signals, separate approver permissions,
  production identity-directory availability, or cross-tenant isolation.
- Exactly-once external provider effects, cross-run business uniqueness, atomic
  Relate-to-Temporal delivery, compensation, or automatic uncertain-write
  recovery.
- Compatibility with old workflow versions. Replay uses histories recorded by
  this version and the same workflow bundle.
- Load, latency, production security, hosting cost, or deployment readiness.
