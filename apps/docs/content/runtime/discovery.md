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

Object detail includes its stable definition ID, API name, display labels,
description, authorized properties, and available traversal directions. Each
property carries its scalar schema, reference target, and authored description.
Action detail includes its described input and output fields, declared failures,
and readable object types it may create.

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
