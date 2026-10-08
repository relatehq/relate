# Architecture Overview

Relate is designed for teams building software and AI agents that work with
operational business data spread across several systems.

> Relate is at a very early stage and is not ready for use. This page describes
> the current design and marks preview features as such.

---

## The Problem: Data Fragmentation and Silos

Businesses rely on fragmented systems of record:

- CRM systems (HubSpot, Salesforce) own accounts and leads.
- Billing providers (Stripe) own charges, subscriptions, and revenue.
- Databases (Postgres, MySQL) own internal operational records such as invoices
  and reviews.

Teams usually solve this in one of two ways:

1. **Bespoke backend glue code:** Every service or agent writes ad-hoc API
   queries and SQL joins, with inconsistent authorization checks and no record
   of how fresh the data is.
2. **Centralized warehouses and lakes:** Teams copy operational data into a
   central store. The copy lags behind the source, the source systems lose
   ownership, and acting on the data still means going back to each system.

---

## The Relate Approach

Relate introduces a **semantic business graph** defined in TypeScript:

```
┌────────────────────────────────────────────────────────┐
│                      Relate Graph                      │
│                                                        │
│   ┌──────────────┐     traversal     ┌─────────────┐   │
│   │   Customer   │ ────────────────> │   Invoice   │   │
│   └──────────────┘                   └─────────────┘   │
│          ▲                                  ▲          │
│          │ mapping                          │ mapping  │
└──────────┼──────────────────────────────────┼──────────┘
           │                                  │
    ┌──────────────┐                   ┌─────────────┐
    │   CRM API    │                   │ Billing DB  │
    │ (Customers)  │                   │  (Invoices) │
    └──────────────┘                   └─────────────┘
```

### 1. Source Ownership

Relate does not replace your primary databases. Sources keep authoritative
ownership of their records, and Relate reads and traverses them through a typed
model. Relate does not write to source systems; writes go through
[native actions](./runtime/actions.md) on records that Relate itself owns.

### 2. Object Identity

Every object in the graph has a typed object ID (`ObjectId<DefinitionId>`). When
Relate adopts a source record, it generates a random ID for it and stores the
mapping, so the ID stays stable even though sources use their own keys.

### 3. Authorization Without Leaks

Relate evaluates declarative policies on every read:

- **Predicate filtering:** A caller only sees records that satisfy their claim
  predicates (e.g. `where: { region: { eq: access.claims.region } }`). A record
  the caller may not read is reported as `not-found`, the same as a missing one.
- **Field groups:** Fields outside the caller's groups are left out of `data`.
  Their field evidence is `{ status: 'forbidden' }` and the read is marked
  `partial`, so the caller can tell a field was withheld but not what it held.
- **One interface for code and agents:** Application code queries through a
  principal-scoped interface. Serving the same interface to AI agents over MCP
  is a preview and not yet implemented.

### 4. Freshness and Provenance Evidence

Every read returns the object data along with **evidence** for each selected
field:

- Whether the value came from a source or from Relate's native storage, and
  which source.
- When the value was observed, and whether it is fresh or stale.
- Whether the observation was retained, and how durably.

Policies can also cap the age of the evidence used to decide access
(`evidenceMaxAgeMs`).

### 5. Native Actions & Receipts

Writes to Relate-owned records are modeled as **actions**:

- Handlers run in a transaction.
- When a declared business rule fails (e.g. an inactive account), the action
  rolls back its native writes and stores an **actor-bound failure receipt**.
- Retries with the same idempotency key return the stored receipt without
  running the handler again.

---

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
  (`createRuntime`, `connect`) used by applications.
