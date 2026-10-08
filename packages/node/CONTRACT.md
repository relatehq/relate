# @relate/node contract

Detailed behavior of the current slice. For an overview of the package, see
[README.md](./README.md).

Application composition for typed, authorized object reads. Private and
unpublished while implementation is in progress.

`defineApp` and `connect` are exported by `relate`. An app definition holds the
graph and deferred setup without executing it. `startApp` from `@relate/node`
runs setup, compiles the graph, creates the runtime, and owns cleanup registered
through `onDispose`. The inspector can compile `app.graph` without running
setup. Direct embedding can use `createRuntime` instead.

```ts
import { createRuntime } from '@relate/node';
import { connect } from 'relate';
import { assertFields } from 'relate';

const relate = createRuntime({
  graph, // defineGraph({ objects: { Customer }, access, policies, ... })
  connections: [
    connect(customers, {
      connectionId: 'crm-primary',
      providerAccountId: 'provider-account-123',
      connector,
    }),
  ],
});

try {
  const id = await relate.host.adopt(Customer, 'crm_456');
  const { objects } = relate.as(principal);
  const customer = await objects.Customer.get(id, { select: ['name'] });
  assertFields(customer, ['name']);
  console.log(customer.data.name); // string
} finally {
  await relate.close();
}
```

The host authenticates `principal`. `as` snapshots it and exposes only consumer
operations; trusted adoption stays on `host`. Reads do not adopt records.
Registry keys name the consumer API; stable definition IDs identify persisted
objects. Adoption accepts the registered object definition, not another object
that happens to have the same ID.

Adoption returns `ObjectId<typeof Customer.id>`. `get` and traversal arguments
require the starting object's branded ID; result IDs and reference fields carry
their own or referenced object's brand. An Invoice ID cannot be passed to
`Customer.get`. The values remain strings in memory, storage, and JSON. For IDs
received from a route or decoded JSON, use
`referenceInput(Customer).parse(rawValue)` from `relate`. This validates a
nonblank string and declares its expected type; runtime membership and access
checks still apply. Provider source keys belong in `host.adopt`, not `get`.

`get` preserves selected property types and returns `ok` or `not-found`. An `ok`
result includes the canonical `id`, selected `data`, and existing read evidence.
Selected fields stay optional because authorization or availability can withhold
them. `assertFields` narrows fields actually present. Omitting `select` requests
all authorized fields. Refresh, stale fallback and strict completeness options
are the same as the underlying engine.

`connect` binds the actual source definition to a connector and stable
`connectionId`. Connections use shared service authorization by default (the
only supported mode). Missing, duplicate or unregistered connections fail at
construction. Explicit provider denial must use `SourceAccessDenied` from
`relate/connectors`; ordinary errors mean temporary unavailability.

Compilation belongs here; `@relate/runtime` still consumes portable compiled
models. Named registries are supported by the compiler alongside existing array
definitions. This API requires a named registry to infer consumer operations.
Supported schemas and policy predicates remain those of `relate`.

Storage defaults to isolated volatile memory; `graphId` defaults to the graph
definition ID. An injected `store` is borrowed: the caller owns migrations and
closing it. `close()` rejects new operations and waits for in-flight operations;
it does not close borrowed storage or provider clients.

Native account-review actions now execute with authorized creation, rollback and
successful receipts and actor-bound lookup/replay; see
[the walkthrough](./NATIVE_ACTIONS.md#wait-for-completion-lookup-and-recovery).
Queries, automatic synchronization, servers and workers remain unimplemented.
See the complete runnable
[hello-world example](../../examples/hello-world/README.md).

Source-backed references and nested read policies support Invoice reads:

```ts
const invoice = await relate.as(ana).objects.Invoice.get(invoiceId, {
  select: ['customer', 'status', 'totalMinor'],
});
```

`customer` is the already-adopted Customer's Relate ID. Ana must match its
portfolio; `totalMinor` additionally requires finance. Another portfolio or
missing/expired policy evidence returns `not-found`. See the executable
[model and acceptance cases](../../dev/fixtures/customer-graph/invoice-read/README.md).

## Bidirectional traversal

Register a `defineRelationship` in `graph.relationships`, using the Invoice's
Customer reference for both directions. Traversal names and selected fields are
inferred from that registry:

```ts
const objects = relate.as(ana).objects;
const page = await objects.Customer.traverse.invoices(customerId, {
  select: ['status', 'totalMinor'],
  limit: 25,
});
const customer = await objects.Invoice.traverse.customer(invoiceId, {
  select: ['name'],
});

for await (const invoice of objects.Customer.traverse.invoices(customerId)) {
  console.log(invoice.id, invoice.data);
}
```

To-many traversal returns a lazy `QueryResult`: await one page or iterate
records across continuations. To-one returns the same `ok`/`not-found` object
shape as `get`. The starting object, reference field and destination must all be
readable; finance does not override portfolio access. Hidden and missing
starting objects produce the same empty final page or `not-found`, according to
cardinality.

Pages enumerate adopted objects, with up to 100 candidates checked per request.
They default to 25 returned records, capped at 100. Empty pages may have a
continuation; final pages have `meta.exhausted: true` and omit the cursor.
Unknown membership evidence on an otherwise readable object rejects with
`ReadError('incomplete')`. This is live enumeration, not a snapshot or a claim
of complete provider coverage.

Cursors hide the scan boundary and bind the caller, graph revision, connections,
starting object, traversal and options. They expire after 15 minutes. The
default key is private to each runtime; supply the same secret 32-byte
`cursorKey` to trusted runtimes sharing storage if continuations must survive
restarts or move between instances. Every page rechecks current access.
