# Discovering the Graph

An agent or application can inspect the graph before choosing an operation.
Discovery uses the same authenticated principal as reads and actions, and it
reveals only statically available capabilities.

Start with the graph overview:

```ts
const consumer = relate.as(principal);
const overview = consumer.describe();

for (const [name, object] of Object.entries(overview.objects)) {
  console.log(name, object.description, object.traversals);
}
for (const [name, action] of Object.entries(overview.actions)) {
  console.log(name, action.description, action.creates);
}
```

The overview includes every visible object and action, keyed by SDK name, plus
all available traversal directions. It does not require search or pagination to
understand the graph. For example, an overview of a Customer/Invoice graph has
this `objects` map:

```json
{
  "Customer": {
    "description": "Organizations that buy our services.",
    "traversals": {
      "invoices": {
        "target": "Invoice",
        "cardinality": "many",
        "description": "Invoices billed to this customer."
      }
    }
  },
  "Invoice": {
    "description": "Amounts billed to customers.",
    "traversals": {
      "customer": {
        "target": "Customer",
        "cardinality": "one",
        "description": "Customer billed by this invoice."
      }
    }
  }
}
```

Traversal targets and action `creates` entries name objects in that same map.
Objects with no available traversals have `traversals: {}`; actions with no
readable created types have `creates: []`. Unauthored descriptions are omitted.
The root omits repeated definition IDs and labels; these remain in detail.

Ask for detail when a particular object or action is relevant:

```ts
const customer = consumer.objects.Customer.describe();
const addReview = consumer.actions.addAccountReview.describe();
```

The overview also carries `definitionRevision`, the compiled model it describes;
successful records report the same value in `meta.definitionRevision`.

Object detail includes its stable definition ID, API name, display labels,
description, authorized properties, and available traversal directions. Each
property carries its scalar schema, reference target, authored description, and
the value a `where` filter on it matches. Action detail includes its described
input and output fields, declared failures, and readable object types it may
create.

## Learning the operations

The root's `sdk` guide explains discovery, reads, actions, receipts, options,
record/page shapes, pagination, evidence and read errors once. It replaces the
verbose root `operations` block and does not repeat option arrays for every
operation:

```ts
const { sdk } = consumer.describe();

sdk.reads.query; // 'await objects.<Object>.query(options?)'
sdk.actions.invoke; // 'await actions.<action>({ input, idempotencyKey })'
sdk.options.limit;
// { description: 'maximum records per page, integer 1–100. Default: 25.',
//   operations: ['query', 'traverse-many'] }
sdk.errors; // ReadError codes and error.issues guidance
sdk.results.pagination; // await → one page; for await → every record
```

`where`, `limit` and `cursor` apply only to queries and to-many traversals. The
other read options also apply to get and to-one traversals. The guide includes
option defaults and machine-readable `operations` for each option, derived from
the same rules as request validation. Printed signatures use these operation
sets. Detailed filter edge cases remain in [Reading Data](./reading-data.md) and
actionable request errors. The full generic read contract and its
`OperationContract` / `OperationContracts` types are exported from
`@relate/runtime` for tooling; it is not included in root discovery.

Object detail fills in the concrete calls and types:

```json
{
  "apiName": "Invoice",
  "operations": {
    "get": {
      "call": "objects.Invoice.get(id, options?)",
      "returns": "Promise<ObjectResult<Invoice>>"
    },
    "query": {
      "call": "objects.Invoice.query(options?)",
      "returns": "QueryResult<Invoice>",
      "collectionScope": "graph-membership"
    }
  },
  "properties": [
    { "name": "customer", "kind": "reference", "filter": "Customer object ID" },
    { "name": "status", "kind": "value", "filter": "string" }
  ],
  "traversals": [
    {
      "name": "customer",
      "cardinality": "one",
      "call": "objects.Invoice.traverse.customer(id, options?)",
      "returns": "Promise<ObjectResult<Customer>>"
    }
  ]
}
```

A reference filter matches a Relate object ID: a record's `id`, or another
record's reference value. Source-system IDs are not object IDs, and an ID that
is not in the graph matches nothing:

```ts
const invoices = await consumer.objects.Invoice.query({
  where: { customer: customerId },
  limit: 10,
});

if (!invoices.meta.exhausted)
  await consumer.objects.Invoice.query({
    where: { customer: customerId },
    limit: 10,
    cursor: invoices.meta.continuationCursor,
  });
```

Printing an operation shows its call signature rather than its implementation:

```ts
String(consumer.objects.Customer.traverse.invoices);
// objects.Customer.traverse.invoices(id: ObjectId<Customer>, options?: { select?, limit?, cursor?, … }): QueryResult<Invoice>
```

A wrong call fails with `ReadError` code `invalid-request`; inspect
`error.issues` for individual option, filter or argument problems. `unavailable`
means a source could not be read; `incomplete` means required evidence was
missing (`requireComplete` or a `where` property). This guidance is included in
`sdk.errors`. See
[Read responses](../reference/read-responses.md#request-errors).

Discovery filters objects, restricted properties, traversals, and actions using
the principal's roles, through the same checks the runtime applies when the
operation runs. An action is listed only when the actor holds its execute role
and may read every object type its input references; a traversal is listed only
when the actor may read its link fields and destination. A record-level rule
such as “customers in the actor's portfolio” is evaluated only when data is read
or an action runs. Discovery means the operation may be attempted; it is not a
promise that any particular record is accessible.

Queries report `collectionScope: 'graph-membership'`. An exhausted query or
traversal has enumerated the currently adopted graph membership. It does not
prove that the source provider contains no other matching records.

Descriptions are authored on the graph, objects, property helpers, relationship
directions, actions, and action fields. See
[Defining the Graph](../authoring/graph.md) and
[Actions, Mutations & Receipts](./actions.md).

A generated client's routing artifact is `compile(graph).consumer`. It includes
its expected graph and model revision. `createConsumer(description, operations)`
checks these against discovery when binding. The artifact is actor independent;
discovery and execution remain actor bound. Refreshing discovery alone does not
update a generated client's types or routing. Future HTTP operations must
enforce model compatibility for every request, including actions and empty
results.
