# Discovering the Graph

An agent or application can inspect the graph before choosing an operation.
Discovery uses the same authenticated principal as reads and actions, and it
reveals only statically available capabilities.

Start with the graph overview:

```ts
const consumer = relate.as(principal);
const overview = consumer.describe();

for (const object of overview.objects) {
  console.log(object.apiName, object.description);
}
for (const action of overview.actions) {
  console.log(action.apiName, action.description);
}
```

The overview stays small. Ask for detail when a particular object or action is
relevant:

```ts
const customer = consumer.objects.Customer.describe();
const addReview = consumer.actions.addAccountReview.describe();
```

The overview also carries `definitionRevision`, the compiled model it describes;
every read reports the same value in `meta.definitionRevision`.

Object detail includes its stable definition ID, API name, display labels,
description, authorized properties, and available traversal directions. Each
property carries its scalar schema, reference target, authored description, and
the value a `where` filter on it matches. Action detail includes its described
input and output fields, declared failures, and readable object types it may
create.

## Learning the operations

Discovery also says how to call each read, so an agent without TypeScript types
(a REPL, plain JavaScript, or another transport) does not have to guess. The
overview carries one SDK-owned contract shared by every graph:

```ts
const { operations } = consumer.describe();

operations.query.options; // ['where', 'select', 'limit', 'cursor', 'evidence', …]
operations.traverse.description; // traverse is an object of named functions…
operations.options; // each option once: name, type, default, description
operations.shapes.QueryResult; // await → one Page; for await → every record
```

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

A wrong call fails with a `ReadError` that names each problem and the accepted
options. See [Read responses](../reference/read-responses.md#request-errors).

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
