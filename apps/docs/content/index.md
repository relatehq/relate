# Why Relate

Relate is an open-source toolkit for building a shared, typed view of business
data across APIs and databases. It gives applications a model of business
objects, their relationships, access rules, and the actions callers can take.

> [!WARNING]
>
> Relate is at a very early stage and is not ready for use. It is published only
> for comment and discussion. The current package version is `0.0.0-dev.0`.

## Business Work Crosses System Boundaries

A customer account rarely lives in one system. The CRM owns the customer record,
a billing database owns invoices, and an internal application records account
reviews. A task as simple as reviewing a customer can require all three.

The application needs more than the values. It needs to know which invoices
belong to this customer, whether the caller may see them, how recently the data
was checked, and whether a retried review submission already succeeded.

Without a shared model, each application or agent integration has to answer
those questions again. Source keys, joins, permission checks, and retry handling
become scattered across integration code.

## A Shared Model for Operational Data

Custom API and database integrations connect individual systems, but each new
consumer still needs a consistent way to interpret and use their data.
Warehouses and lakes bring data together for analysis, but operational work also
needs caller-specific access, freshness checks, and a way to record actions.

Relate brings those concerns into a **semantic business graph** defined in
TypeScript. You describe business entities such as customers and invoices, map
their properties to sources, and declare the relationships between them.

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

The CRM and billing database remain authoritative for their records. Relate
keeps the identities and observations it needs to operate the graph, while
Relate-owned objects can hold new records such as account reviews.

## What This Gives Your Application

### A Common Business Vocabulary

Applications work with `Customer`, `Invoice`, and their relationships through a
typed interface. The graph captures how those entities fit together, so each
consumer does not have to reconstruct that meaning from raw provider responses.

### Access Rules Alongside the Model

You declare who can read records, which fields they may see, and which actions
they can invoke. The runtime applies those rules to reads, traversal, and
actions using the authenticated caller supplied by your application.

For example, an account manager can be limited to customers in their region,
while financial fields require an additional role.

### Evidence Alongside the Data

A returned value comes with evidence about its availability, origin, and
freshness. Your application can distinguish a fresh invoice amount from a stale
observation or a withheld field, instead of treating every response as equally
complete and current.

### Actions with Recoverable Results

Native actions create Relate-owned records transactionally and return receipts
for success or declared business failure. Idempotency keys let a caller retry a
submission without creating the same account review twice.

## Where Relate Fits Today

The current implementation runs embedded in a Node application. Your host
supplies connectors, authenticates callers, and chooses memory or Postgres for
Relate's runtime state. Source systems keep ownership of their data; current
actions create native records and do not write back to external systems.

Relate is intended for software and AI agents working with operational business
data. An MCP interface is planned but is not yet implemented. The APIs and
storage implementation are still under development.

## Continue Reading

- **[Getting Started](./getting-started.md)**: Run an example and build your
  first graph.
- **[Key Concepts](./key-concepts.md)**: Understand the main moving parts as an
  author.
- **[Architecture Overview](./overview.md)**: See how the runtime implements the
  model, access checks, evidence, and actions.
