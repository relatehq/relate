# Architecture Overview

Relate runs an authored TypeScript graph inside an embedded runtime. The host
application supplies source connectors, action implementations, storage, and an
authenticated principal for each caller.

[Why Relate](./index.md) explains the problem this solves. This page describes
how the current implementation fits together; it remains an early development
baseline, not a production-ready system.

## From Definitions to a Running Graph

Authors use `relate` to define sources, objects, relationships, access policies,
and action contracts. `defineGraph` assembles them into a model. The compiler in
`relate/compiler` validates that model and produces a serializable manifest and
a deterministic definition revision.

`createRuntime` from `@relate/node` compiles the graph and binds it to
connectors, action handlers, and a store. Alternatively, `defineApp` packages
the graph with deferred setup, and `startApp` runs that setup to create the
runtime. Keeping setup deferred lets the Inspector load the definitions without
starting connectors or opening a database.

The runtime's `graphId` identifies an installation. Stores pin it to a
definition revision; the Postgres store rejects a different revision for an
existing installation. Migration between model revisions is not yet implemented.
See
[Graph Compilation](./authoring/graph.md#4-graph-compilation--revision-pinning).

## Source Bindings and Object Identity

A source definition describes records; `connect` from `relate` binds that source
to a connection and connector. The connector fetches records by their source
keys. Identity can be provider-verified or explicitly owned by the application
through its stable `connectionId`; see
[Sources and Connections](./key-concepts.md#sources-and-connections).

When the host adopts a source record, Relate generates an object ID and stores
its mapping to the source identity. Reads use this mapping to reach the original
record. Source-backed references resolve source keys through existing adopted
targets, and registered relationships expose traversal over those references.

The source remains authoritative. Relate's store holds adopted identities and
observations separately from the source records. Native objects are owned and
stored by Relate. See [Key Concepts](./key-concepts.md) for the identity terms.

## Reads, Authorization, and Evidence

The host authenticates a caller and supplies their ID, roles, and claims through
`relate.as(principal)`. The resulting interface scopes object reads, traversal,
and action calls to that principal.

For a read, the runtime resolves the object's membership, evaluates its read
policy, and resolves selected fields using stored observations or connector
fetches as needed. Policy predicates can follow references. Their
`evidenceMaxAgeMs` bounds the age of observations used for authorization;
`maxAgeMs` on the read separately controls freshness of returned values.

The result preserves the distinction between record access and field access:

- A missing or hidden record returns `{ status: 'not-found' }`.
- A readable record returns `{ status: 'ok', id, data, meta }`.
- A field blocked by its field-group policy is omitted from `data` and marked
  `{ status: 'forbidden' }` in `meta.fields`; the read is marked `partial`.
- Available fields carry evidence of their origin and freshness, including when
  the value was observed and whether the observation was retained durably.

Traversal applies authorization to its results as well. See
[Access Control](./authoring/access-control.md) for policy evaluation and
[Reading Data](./runtime/reading-data.md) for freshness, pagination, and
traversal coverage.

## Native Transactions and Receipt Recovery

An action contract declares input, output, execution access, permitted native
creations, and optional business failures. A server-side implementation runs
with caller-scoped reads and native creation methods.

The runtime coordinates native writes and receipt storage in a transaction. A
successful invocation commits its writes and success receipt. A declared
`fail(...)` rolls back native effects and records a typed failure receipt.
Unexpected handler errors roll back and reject the call without a receipt.

Receipts are bound to the actor. Reusing an idempotency key for the same action,
actor, and input returns the stored receipt without rerunning the handler, after
current-access checks. A different actor or input is rejected. See
[Actions](./runtime/actions.md) for the full result and rejection contracts.

Current actions create native records; external-system writes and durable
pending execution are not implemented.

## Runtime Storage

The default store is in memory. It retains graph installation state, adopted
identities, observations, native records, and receipts for the lifetime of the
process. The Postgres store makes that state durable in a dedicated `relate`
schema without changing source or application tables.

The host explicitly migrates and supplies a Postgres store and owns its cleanup.
A Postgres database used as a source is a separate concern from the store used
for runtime state. See [Persistence](./deployment/postgres.md) for setup.

## Package Responsibilities

Relate is split into packages with explicit dependency boundaries. Arrows point
from a package to what it depends on:

```
[ protocol ]   Wire contracts and evidence types (no dependencies)
     ▲
[ relate ]     Authoring API and compiler
     ▲
[ runtime ]    Query engine, policy evaluation, action coordination
     ▲    ▲
     │    └──────────────┐
[ node ]                 [ postgres ]
Embedded runtime         Durable store
```

`node` and `postgres` do not depend on each other; the host application creates
a Postgres store and passes it to `createRuntime`.

- **[`relate`](../../../packages/relate/src/index.ts)**: Authoring APIs
  (`defineSource`, `defineObject`, `defineGraph`, `defineAccess`,
  `defineAction`) and the compiler (`relate/compiler`). The authoring imports do
  not depend on Node or a database; the compiler uses `node:crypto`.
- **[`@relate/protocol`](../../../packages/protocol/src/index.ts)**: Shared
  result, evidence, and receipt types.
- **[`@relate/runtime`](../../../packages/runtime/src/index.ts)**: Query
  execution, policy evaluation, relationship traversal, action coordination, and
  the in-memory store.
- **[`@relate/postgres`](../../../packages/postgres/src/index.ts)**: Postgres
  store, schema migrations, and transactions. Private and not ready for
  application use.
- **[`@relate/node`](../../../packages/node/src/index.ts)**: The embedded SDK
  (`createRuntime`, `startApp`) used by applications.
