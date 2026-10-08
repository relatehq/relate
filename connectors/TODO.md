# TODO: first connector packages

SQLite is implemented first; Stripe will extend the customer-accounts example
and help refine the connector contract. This is a temporary implementation note,
not a description of available APIs. Delete this file once implemented and move
any lasting usage guidance into the package READMEs.

## Package responsibilities

| Package                                          | Responsibility                                                                               |
| ------------------------------------------------ | -------------------------------------------------------------------------------------------- |
| `relate`                                         | Graphs, sources, portable application definitions, and connection bindings                   |
| `@relate/connector-sqlite` (`connectors/sqlite`) | SQLite connections and table resources                                                       |
| `@relate/connector-stripe` (`connectors/stripe`) | Stripe connections and API resources                                                         |
| `@relate/node`                                   | Starting and hosting an embedded runtime in Node                                             |
| `@relate/runtime`                                | Authorization, observation validation, retention, freshness, ordering, and account isolation |

- [x] Move portable `connect` and `defineApp` authoring out of `@relate/node`
      into `relate`, with contracts arranged to avoid a dependency cycle.
- [x] Keep graph/app authoring usable without importing `@relate/node`. Explicit
      Node embedding can import the host package.
- [x] Keep connection setup deferred: inspecting an app or graph must not open
      databases or require live credentials.
- [x] Model connectors as systems, with resources selected within a connection.
      Customers and invoices are resources, not connector packages. One system
      connection should support multiple resources.

SQLite's implemented shape is
`sqlite({ path, identity }).table(name, { idColumn })`. Stripe's resource API
remains to be designed; keep one system connection with resource selection, and
bind each resource using `connect(source, binding)`.

Shared interfaces now live in `relate/connectors`; application authoring is in
`relate`, and type-only storage contracts are in `relate/storage`. SQLite now
implements system/resource selection; see [its README](sqlite/README.md) for the
actual API. The Stripe sketch remains unimplemented.

## SQLite

- [x] Implement `@relate/connector-sqlite` against a real local SQLite database,
      with reproducible seed/reset fixtures and table-backed record reads.
- [ ] Exercise relational data, keys, and mappings through a runnable Relate
      example. SQLite is the application's source database here; adding SQLite
      as Relate's own persistence backend is a separate decision.
- [x] Specify database identity, record ID mapping, SQL-to-JSON value handling,
      resource ownership, and cleanup. Do not pretend a local database has a
      SaaS provider account or treat a filename alone as verified identity.

## Stripe

- [ ] Implement `@relate/connector-stripe` using Stripe's actual API, starting
      with invoices for the shared example.
- [ ] Use a hosted Stripe sandbox for provider integration tests. Use
      deterministic local fixtures for the fast development/test loop.
- [ ] Do not rely on `stripe-mock` for behavioral correctness: it is stateless
      and cannot prove update/read/delete or permission behavior.
- [ ] Specify authenticated account identity, credential handling, response
      mapping, cancellation, and provider error/deletion semantics.

References:

- [Stripe sandboxes](https://docs.stripe.com/sandboxes)
- [Official stripe-mock limitations](https://github.com/stripe/stripe-mock)

## Shared implementation and acceptance

- [ ] Refine the existing `identify`/`fetch` extension contract using both
      implementations. Resolve system identity versus resource identity, source
      schemas, connection IDs, and lifecycle before settling signatures.
- [ ] Keep application objects, business mappings, and policies
      application-owned; connectors own provider access and normalization.
- [ ] Build a runnable example relating SQLite-owned customers to Stripe-owned
      invoices, with explicit adoption of known source IDs and authorized reads.
- [ ] Verify upstream changes appear on refresh; explicit provider denial does
      not enable stale fallback; deletion requires affirmative evidence;
      account/connection changes cannot disclose earlier observations; and
      cancellation reaches outstanding I/O.
- [ ] Keep discovery, bulk sync, webhooks, and external writes outside the first
      read-focused slice unless separately agreed.
- [ ] Document the implemented public API, verify imports through built
      packages, and delete this TODO when the agreed slice is complete.
