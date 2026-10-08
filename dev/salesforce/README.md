# Salesforce development tooling

This private package manages disposable Salesforce scratch orgs: creation, seed
Accounts, CLI credentials, reset, ownership checks, and cleanup. It is shared by
the example launcher and the opt-in live integration suite.

- The user-facing application and model live in
  [`examples/05-salesforce`](../../examples/05-salesforce/README.md).
- Simulated connector/runtime checks live in
  [`tests/unit/salesforce.test.ts`](../../tests/unit/salesforce.test.ts).
- Live checks live in
  [`tests/integration/salesforce.live.ts`](../../tests/integration/salesforce.live.ts)
  and run only with `pnpm test:salesforce:live`.
- Both integration suites use test-owned application definitions in
  `tests/support/salesforce/`.
- `test/harness.test.ts` verifies this package's org lifecycle tooling without
  calling Salesforce.

Use `pnpm salesforce:dev create|reset|delete` to manage a retained development
org. See the
[setup and lifecycle guidance](../../connectors/salesforce/README.md) for
prerequisites and recovery commands.
