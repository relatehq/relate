# Key Concepts

As a Relate author, you define the business objects your application works with,
where their data comes from, who can access it, and what actions callers can
take. You then connect that model to real systems and run it.

Consider a customer account: a CRM owns the **Customer**, a billing database
owns its **Invoices**, and Relate owns **Account Reviews** created by your team.
These records form one graph while retaining their separate owners.

This page describes the currently implemented authoring model. Relate is still
at an early stage and is not ready for application use.

## Sources and Connections

A **source** describes a kind of record in an external system. `defineSource`
declares its schema and the field containing its record key. For example, a
customer source might describe CRM records with `id`, `name`, and `region`.

A **connection** supplies the runtime binding for that source. `connect` pairs
the definition with a connector that fetches records. Provider-verified
connectors also identify the account; application-owned connectors explicitly
rely on the host’s stable `connectionId`. The connector contains the API or
database integration code and keeps credentials outside the graph definition.

```ts
// Excerpt: crmCustomers is a source definition; crmConnector reads the CRM.
const crmConnection = connect(crmCustomers, {
  providerAccountId: 'crm-prod',
  connectionId: 'crm-main',
  connector: crmConnector,
});
```

The binding above uses provider verification: the connector proves which account
it reads from, and Relate checks that against `providerAccountId`. A connector
with no provider account to verify, such as one reading a local database file,
can use application-owned identity instead: omit `providerAccountId` and give
each logical source its own `connectionId`. Relate cannot detect a substituted
source under the same ID in that mode, and switching modes does not reuse
retained identities. Each connector package documents its own options.

The source describes what a record looks like; the connection determines how to
read it in a particular environment. See [Graph Modeling](./authoring/graph.md)
for source definitions and [Getting Started](./getting-started.md) for a working
connector.

## Objects, Membership, and Properties

An **object definition** describes a business entity such as `Customer` or
`AccountReview`. An individual customer is a record of that object type.
`defineObject` brings together its membership, properties, and display labels.

**Membership** says where records of that type come from:

| Membership             | Owner              | Example                              |
| ---------------------- | ------------------ | ------------------------------------ |
| `source(crmCustomers)` | An external system | Customers read from the CRM          |
| `nativeMembership()`   | Relate             | Account reviews created by an action |

**Properties** are the fields callers see. Each has a stable definition ID and a
typed value:

| Helper                             | Meaning                                              | Example               |
| ---------------------------------- | ---------------------------------------------------- | --------------------- |
| `objectId({ id })`                 | The record's Relate identity; exactly one per object | Customer object ID    |
| `from(sourceField, { id })`        | A field mapped from the membership source            | Customer name         |
| `native(schema, { id })`           | A value stored by Relate                             | Account review note   |
| `reference(Target, { id, from? })` | A typed pointer to another object                    | An invoice's customer |

A source-backed object currently has one membership source, and its mapped
properties must come from that source. Native objects use native properties and
references for values created by actions. See
[Graph Modeling](./authoring/graph.md) for complete definitions.

## Identity and Adoption

There are several names and IDs in a model, each with a different purpose:

| Name or ID        | Example                                            | Purpose                                                                |
| ----------------- | -------------------------------------------------- | ---------------------------------------------------------------------- |
| Definition ID     | `'business.customer'`                              | Stable identity of an object type; properties also have definition IDs |
| Registry key      | `Customer` in `objects: { Customer }`              | Public API name, such as `objects.Customer`                            |
| Display label     | `'Customer account'`                               | Human-facing wording                                                   |
| Source record key | `'cust_101'`                                       | Identifies a record within its source                                  |
| Object ID         | A Relate-generated `ObjectId<'business.customer'>` | Identifies an individual record in the graph                           |

**Adoption** gives an existing source record its Relate object ID and stores the
mapping to the source key:

```ts
const customerId = await relate.host.adopt(Customer, 'cust_101');
```

Adoption is a host operation. It establishes graph membership without granting
callers access to the record. Native records receive an object ID when an action
creates them.

Use object IDs for graph reads and action inputs. Keep definition IDs stable as
the model evolves; changing a registry key changes the caller-facing API. See
[Reading Data](./runtime/reading-data.md) for adoption and typed IDs.

## References and Relationships

A **reference** is a property on one object pointing to another. For example,
`Invoice.properties.customer` points to a `Customer`. A source-backed reference
maps a source key to an existing adopted target; a native reference stores the
target's Relate object ID.

A **relationship** gives that reference named traversal paths in both
directions:

```ts
const CustomerInvoices = defineRelationship({
  id: 'customer.invoices',
  forward: 'invoices',
  reverse: 'customer',
  via: Invoice.properties.customer,
});
```

After registration in the graph, callers can use
`objects.Customer.traverse.invoices(customerId)` and
`objects.Invoice.traverse.customer(invoiceId)`. Traversal applies access rules
to the records it returns. See [Graph Modeling](./authoring/graph.md) for
registration and [Reading Data](./runtime/reading-data.md) for pagination and
traversal coverage.

## Access Definitions, Policies, and Principals

An **access definition** declares the roles, claims, and field groups available
to your model. **Policies** use that vocabulary to decide who can read records,
see particular fields, or create native records.

A **principal** is the authenticated caller supplied by your host application:

```ts
const caller = relate.as({
  id: 'ana',
  roles: ['sales'],
  claims: { region: 'emea' },
});
```

The host authenticates Ana and supplies her roles and claims. Relate evaluates
the policies when she operates on the graph. For example, a customer policy can
require the `sales` role and match the customer's region to Ana's claim.

Every object needs an explicit read policy. A hidden record returns `not-found`;
a withheld field is omitted from `data` and marked `forbidden` in the result's
evidence. See [Access Control](./authoring/access-control.md).

## Actions and Receipts

An **action** is a named operation a caller can invoke, such as
`addAccountReview`. `defineAction` declares its input, output, execution policy,
which native objects it may create, and any expected business failures.
`implementAction` supplies the server-side handler.

Actions currently create Relate-owned records in a transaction. They do not
write to the CRM or billing system. A handler can read as the caller, create
permitted native records, and use `fail(...)` to report a declared business
failure while rolling back its writes.

A **receipt** records a successful result or a declared business failure. An
invocation includes an idempotency key: retrying the same action with the same
caller, input, and key returns its stored receipt after current-access checks.
Unexpected errors and authorization rejections are thrown rather than recorded
as business-failure receipts. See [Actions](./runtime/actions.md).

## Graphs, Apps, and the Runtime

A **graph** assembles your definitions into one model with `defineGraph`:

```ts
// Excerpt: definitions and policies are authored in their own modules.
const graph = defineGraph({
  id: 'business',
  objects: { Customer, Invoice, AccountReview },
  relationships: { CustomerInvoices },
  actions: { addAccountReview: AddAccountReview },
  access,
  policies,
});
```

Compilation validates the graph and produces a **manifest**, a serializable
description of the model, plus a **definition revision** identifying that exact
definition. The runtime compiles the graph for you. See
[Graph Compilation](./authoring/graph.md#4-graph-compilation--revision-pinning)
for revision pinning and its current migration limits.

An **app** packages the graph with deferred environment setup:

```ts
const app = defineApp({
  graph,
  setup() {
    return {
      graphId: 'business-prod',
      connections: [crmConnection, billingConnection],
      actionImplementations: [addAccountReview],
    };
  },
});

const relate = await startApp(app); // startApp comes from @relate/node.
```

`defineApp` starts nothing. `startApp` runs setup and creates the **runtime**,
which executes reads, traversal, and actions. You can also call `createRuntime`
directly with the graph and its bindings. The runtime `graphId` identifies an
installation of the graph; the graph definition's `id` identifies the model.
Close the running instance with `await relate.close()` when finished.

The [Inspector](../../../packages/cli/README.md) can load the graph or app to
display the model without calling app setup.

## Observations, Evidence, and Storage

An **observation** is what Relate learned about a source record at a particular
time. Reads return selected data alongside **evidence** describing field
availability, origin, and freshness. A successful read can still have missing
fields, so callers should inspect the evidence or use `assertFields` for values
they require.

The runtime's **store** retains adopted identities, observations, native
records, and action receipts. It defaults to memory; Postgres provides durable
storage. This store is separate from a billing database connected as a source,
even if both use PostgreSQL: one owns Relate's runtime state, the other owns
invoices.

See [Reading Data](./runtime/reading-data.md) for evidence and freshness, and
[Persistence](./deployment/postgres.md) for store setup.
