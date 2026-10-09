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

## Setup and Lifecycle

Salesforce CLI is optional for connector consumers. The repository development
harness uses the CLI and a persistent Dev Hub to provision disposable scratch
orgs; it never uses the Dev Hub as the connector's data source.

1. Create a [Developer Edition account](https://developer.salesforce.com/signup)
   and
   [enable Dev Hub](https://developer.salesforce.com/docs/platform/sfdx-dev/guide/sfdx-setup-enable-devhub.html).
2. Install
   [Salesforce CLI](https://developer.salesforce.com/tools/salesforcecli). This
   harness was verified with CLI 2.153.5, including
   `sf org auth show-access-token`.
3. Authenticate the default Dev Hub:

   ```sh
   sf org login web --alias relate-hub --set-default-dev-hub
   ```

From the repository root:

```sh
# Create, seed, explore interactively, and delete on normal exit or Ctrl-C.
pnpm example:salesforce

# Same lifecycle, print seeded customers once and exit.
pnpm example:salesforce --once

# Explicitly retain one org across development commands.
pnpm salesforce:dev create
pnpm example:salesforce --existing
pnpm salesforce:dev reset
pnpm salesforce:dev delete

# Separately selected live suite: creates one org, shares it, deletes in finally.
pnpm test:salesforce:live

# Deterministic local tests: no CLI, credentials, provisioning, or network.
pnpm test:unit -- connectors/salesforce/test
```

The retained example does not own the org lifecycle; use `salesforce:dev delete`
when finished. Reset deletes only recorded fixture Account IDs and seeds
Northwind/Contoso automatically. Do not run reset/delete while an example or
live suite is using the org. A second create refuses to overwrite existing
state. All commands use the worktree-local `.relate/salesforce.json` ownership
record. It contains the Dev Hub identity, unique scratch username, creation job
ID, org ID, and seeded Account IDs, **never access tokens**. Do not remove it
before teardown. Do not edit its ownership fields or move it between worktrees.

The harness records intent before provisioning and recovers a lost creation
response through the Dev Hub's `ScratchOrgInfo`. Before seeding, credential
retrieval, or deletion it checks the recorded identity against the CLI's scratch
org inventory and the owning Dev Hub; a Dev Hub or unrelated org is refused.
Normal runner exit, handled interruption, and setup/assertion failures attempt
cleanup. Signals wait for the current CLI command to settle before cleanup.
Failed cleanup keeps the recovery record and reports
`pnpm salesforce:dev delete` without hiding the error that ended the run.
Deletion first asks the Dev Hub for the signup: if creation was rejected or the
org has already expired, only the local record is removed. A crash, SIGKILL, or
network outage may require that command on the next run. Scratch orgs expire
after **one day** as a backstop. Active-org and daily creation allocations still
apply; reuse/reset retained orgs during development.

Live tests cover verified identity, seeded reads through Relate, upstream
updates, invalid-session denial, and soft deletion. Local tests cover
sharing-like empty results, field/object denial, org changes, transport and
validation failures, and cleanup safeguards. The live suite does not configure
restricted Salesforce profiles or exhaustively test sharing/FLS permutations.
Installed-tarball checks exercise this package under plain Node ESM and
TypeScript NodeNext without CLI.
