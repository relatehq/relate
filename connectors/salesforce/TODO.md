# TODO: Salesforce connector

This is the agreed implementation plan for `@relate/connector-salesforce`. The
connector and development harness are not implemented yet. Delete this file when
the work below is complete; keep lasting setup and usage guidance in
[README.md](README.md).

## Read-only first slice

- [ ] Implement a read-only Salesforce connector using the existing
      `relate/connectors` contracts. Start with Account records mapped to
      application-owned Relate Customer objects.
- [ ] Follow the existing system/resource pattern: one Salesforce connection
      owns credentials and provider access, with resources selected within it.
      Settle the exact public API during implementation.
- [ ] Verify authenticated Salesforce org identity; define credential handling,
      response validation, cancellation, timeouts, and provider error mapping.
      Explicit access denial must not become temporary unavailability, and
      deletion requires affirmative evidence rather than a failed lookup.
- [ ] Keep Salesforce CLI and scratch-org provisioning out of the connector's
      runtime dependencies. Seeding writes belong to the development harness;
      the connector remains read-only. Discovery, continuous sync, and provider
      writes are outside this first slice.

## Disposable development environments

Use a persistent Dev Hub account to create real, disposable Salesforce scratch
orgs. Bootstrap their configuration and seed data automatically; users should
not have to enter example records manually in Salesforce.

```text
Authenticated Dev Hub
  -> create scratch org
  -> apply required configuration and seed records
  -> connect Relate using the scratch org's identity and credentials
  -> run an interactive example or focused live integration suite
  -> delete the scratch org
```

- [ ] Add development tooling for create, seed/reset, and teardown. Record the
      created org identity so cleanup targets only the owned scratch org, never
      the persistent Dev Hub or an unrelated Salesforce org.
- [ ] Support interactive examples that keep an org available while someone
      explores Relate. Provide an explicit teardown command, plus cleanup on
      normal exit and handled interruption where the runner owns the lifecycle.
- [ ] Register cleanup as soon as an org is created, including when seeding,
      setup, or assertions fail. Use `finally`/test teardown and handle normal
      termination signals. Report deletion failures with a recovery command.
- [ ] Set a short expiration as a backstop for crashes or interrupted cleanup;
      expiration does not replace explicit teardown. Retain enough local
      ownership information to clean up an orphan on a subsequent run.
- [ ] Reuse/reset an org during an interactive development session and share
      provisioning across a focused test suite instead of creating one per
      assertion. Respect Dev Hub active-org and daily creation allocations.
- [ ] Keep credentials out of fixtures, committed files, and test output.

## Focused testing

- [ ] Keep deterministic connector and Relate contract tests in the normal test
      suite, without Salesforce credentials, CLI, or live network access.
- [ ] Add a small, explicitly selected live integration suite for the connector.
      Ordinary repository tests must not provision scratch orgs or run this
      suite; document the separate command and required Dev Hub authentication.
- [ ] Exercise seeded Account reads through Relate, upstream updates followed by
      refresh, and provider identity/access/deletion behavior supported by the
      fixture. Cover transport failures and other edge cases locally.
- [ ] Give each test explicit arrange/act/assert state and owned cleanup. Put
      fixtures and harness helpers outside `examples/`; connector tests must not
      import example code. Examples may consume development tooling.
- [ ] Verify the package through built imports and document which checks ran
      locally versus against Salesforce.

## Documentation and completion

- [ ] Update the README with the implemented connector API and exact example,
      seed/reset, live-test, and teardown commands.
- [ ] Preserve the distinction between optional CLI tooling for connector
      consumers and the CLI-based Dev Hub workflow used by contributors.
- [ ] Delete this TODO once the agreed slice is implemented and verified.
