# @relate/node

> Development baseline (`0.0.0-dev.0`), for discussion and contribution only.
> Not ready for application use. APIs and behavior are incomplete and may change
> without notice.

Application composition for Node: compile an authored graph, bind connections
and action implementations, and expose a typed, authorized consumer API. Private
and unpublished while implementation is in progress.

## Responsibility

- `createRuntime({ graph, connections, actionImplementations?, store?, … })`
  compiles the graph with `relate/compiler`, validates connections against the
  registered sources, binds action handlers, and starts a `@relate/runtime`
  engine.
- `relate.as(principal)` returns consumer operations whose names and types are
  inferred from the graph's object registry: `objects.Customer.get`,
  `objects.Customer.query`, `objects.Customer.traverse.invoices`,
  `actions.addAccountReview`. The facade itself is `createConsumer` from
  `relate/consumer`, shared with the planned HTTP client.
- `relate.operations(principal)` returns the engine bound to that principal as
  the `ConsumerOperations` contract from `@relate/protocol`: untyped, addressed
  by definition IDs, and the surface the planned `@relate/http` and
  `@relate/mcp` adapters serve. Calls after `close()` reject.
- The same actor-bound handle exposes progressive discovery through
  `describe()`, `objects.Customer.describe()`, and
  `actions.addAccountReview.describe()`.
- `relate.host.adopt(Customer, sourceRecordId)` is the trusted membership
  operation; `relate.close()` drains in-flight work.
- `connect` and `defineApp` are portable authoring helpers imported from
  `relate`. This package executes their definitions.

Authorization, transactions and evidence belong to the engine. This package adds
types, composition and lifecycle. Storage defaults to isolated memory; an
injected store is borrowed.

## How it fits

- Depends on `relate`, `relate/compiler` and `relate/consumer`,
  `@relate/runtime` and `@relate/protocol`.
- The embedded entry point for applications today. Planned HTTP and MCP adapters
  serve `relate.operations(principal)`. The existing CLI inspects definitions
  without starting a runtime.

## Public API

```ts
import { z } from 'zod';
import {
  assertFields,
  defineAccess,
  defineGraph,
  defineObject,
  defineSource,
  from,
  objectId,
  source,
} from 'relate';
import { createRuntime } from '@relate/node';
import { connect } from 'relate';

const people = defineSource({
  id: 'example.people',
  idField: 'id',
  schema: z.object({ id: z.string(), name: z.string() }),
});
const Person = defineObject({
  id: 'example.person',
  membership: source(people),
  properties: {
    id: objectId({ id: 'example.person.id' }),
    name: from(people.fields.name, { id: 'example.person.name' }),
  },
});
const access = defineAccess({
  roles: ['reader'],
  claims: {},
  fieldGroups: ['ordinary'],
});
const graph = defineGraph({
  id: 'example.graph',
  objects: { Person },
  access,
  policies: { Person: { read: { gate: access.role('reader') } } },
});

const relate = createRuntime({
  graph,
  connections: [
    connect(people, {
      connectionId: 'directory',
      providerAccountId: 'example-account',
      connector: {
        // This in-memory fixture is its own provider. Real adapters authenticate.
        identify: async () => 'example-account',
        async fetch(id) {
          return id === '1'
            ? {
                providerAccountId: 'example-account',
                state: 'present',
                record: { id: '1', name: 'Ada' },
              }
            : { providerAccountId: 'example-account', state: 'deleted' };
        },
      },
    }),
  ],
});

try {
  const id = await relate.host.adopt(Person, '1'); // ObjectId<'example.person'>
  const { objects } = relate.as({
    id: 'reader-1',
    roles: ['reader'],
    claims: {},
  });
  const person = await objects.Person.get(id, { select: ['name'] });

  assertFields(person, ['name']); // a selected field can still be withheld
  console.log(person.data.name); // string
} finally {
  await relate.close();
}
```

With relationships and actions registered in the graph, the same handle exposes
traversal and action calls:

```ts
const { objects, actions } = relate.as(ana);

const page = await objects.Customer.traverse.invoices(customerId, {
  where: { status: { in: ['open', 'overdue'] } },
  select: ['status'],
  limit: 25,
});

for await (const invoice of objects.Customer.traverse.invoices(customerId)) {
  console.log(invoice.id, invoice.data.status);
}

const receipt = await actions.addAccountReview({
  input: { customer: customerId, note: 'Follow up' },
  idempotencyKey: 'review-2026-10',
});
const recovered = await relate
  .as(ana)
  .receipts.get('addAccountReview', receipt.invocationId);
// recovered.output contains the original result; the action is not executed again.
```

## Discovering the graph

Start with a small actor-bound overview, then request detail only for the
capability needed by the task:

```ts
const consumer = relate.as(ana);
const overview = consumer.describe();
const customer = consumer.objects.Customer.describe();
const addReview = consumer.actions.addAccountReview.describe();
```

The overview contains all readable object types and executable actions in
name-keyed `objects` and `actions` maps. Objects include named traversal targets
and cardinalities; actions include readable created-object names. The shared
`sdk` guide covers calls, read options/defaults and applicability, record/page
results, pagination and read-error guidance without loading property schemas.
Object detail contains authorized properties, traversals, scalar constraints,
and their descriptions. Action detail contains its described input, output,
failures, and readable created-object types. Unauthorized definitions and
restricted fields are omitted.

Discovery reports `collectionScope: 'graph-membership'` for `query`. It does not
claim that adopted records cover an entire provider. Record-dependent policy
conditions and current data access are still checked when an operation runs.

## Application definitions

`defineApp` from `relate` packages the graph with deferred setup.
`startApp(app)` runs setup, composes the runtime, and owns cleanup registered
with `onDispose`. The Inspector loads definitions without calling setup.

See
[Application Setup & Lifecycle](../../apps/docs/content/runtime/application.md)
for the complete setup, storage ownership, failure cleanup, and shutdown guide.

## Status

Implemented: typed reads and graph queries, source-backed references,
bidirectional traversal with pagination, native actions with atomic success or
declared-failure receipts, and actor-bound lookup/replay with current-access
checks. Ordinary calls wait for completion. Actor-bound discovery exposes the
portable meaning and structure of these operations without returning source
mappings or policy internals. `startApp` executes a portable `defineApp`
descriptor and owns registered cleanup. Not implemented: background submission,
provider-wide queries, automatic synchronization, servers and workers.

## Further reading

- [CONTRACT.md](./CONTRACT.md): read, adoption, connection, traversal and cursor
  semantics in detail.
- [NATIVE_ACTIONS.md](./NATIVE_ACTIONS.md): the account-review action path end
  to end.
- [Todo notes](../../examples/01-todo-notes/README.md) and
  [Postgres persistence](../../examples/03-postgres-persistence/README.md).

## Graph queries

```ts
const page = await relate.as(principal).objects.Person.query({
  where: { name: 'Ada' },
  select: ['name'],
  limit: 25,
});
```

`query()` without options enumerates accessible graph members. Properties and
operators combine with AND. Use scalar equality or `eq`/`in`; numbers and
timestamps additionally support `gt`/`gte`/`lt`/`lte`. References accept typed
Relate IDs, including in sets. Await one page or iterate records with
`for await`. Each record retains the same selected data and field evidence as
`get`. Filters must be readable even when omitted from `select`.

Source-backed queries cover adopted records only; native queries cover records
created in Relate. Direct source queries and source sync are planned. See the
[runtime query contract](../runtime/CONTRACT.md#graph-queries) for pagination,
freshness, errors and concurrency limits. The same query API is available in
`implementAction`, including native read-your-writes and rollback on failure.

## Compact evidence

Reads default to compact evidence; pass `evidence: 'full'` for every selected
field's provenance. Values and access rules are identical in both modes.

See
[Read Responses & Evidence](../../apps/docs/content/reference/read-responses.md)
for the complete reference.

## Host activity and provenance

Trusted hosts can follow committed changes and action completions, browse
best-effort attempts, and read permanent creation/adoption attribution:

```ts
const page = await relate.host.activity.feed.read({ limit: 100 });
for (const entry of page.entries) await processIdempotently(entry);
await saveCheckpoint(page.nextCursor);
const next = await relate.host.activity.feed.read({ cursor: page.nextCursor });

const attempts = await relate.host.activity.operations.list({
  filter: { object: { objectDefinitionId: Person.id, objectId: id } },
});
const provenance = await relate.host.provenance({
  objectDefinitionId: Person.id,
  objectId: id,
});
```

The feed contains `created`, `adopted`, `updated`, `deleted`, `restored`,
`invocation-succeeded`, and `invocation-failed` entries in publication order.
Entries contain metadata and stable property IDs, never values, action inputs,
outputs, query predicates, or raw errors. Replay returns the original receipt
without another native change or invocation event. Source refreshes can commit
independently during receipt authorization, even if the enclosing action fails.

`operations.list` is newest-first browsing, not a delivery checkpoint. Rows are
captured after authorization, with ordered direct object references and
returned/forbidden/unavailable property IDs. A refresh is a nested operation;
its source change preserves both the source actor and the triggering actor.
Missing operation rows never prove that an operation did not happen.

Supply filters only on the initial request; a cursor retains the filter. Limits
default to 50 (maximum 500). Feed cursors advance past nonmatching entries and
reject expired history explicitly. `ActivityError.code` distinguishes
`unsupported`, `unavailable`, `invalid-request`, `invalid-cursor`, and
`cursor-expired`. `activity.status()` distinguishes unsupported storage from
available volatile/persistent history and reports whether capture is enabled.
Object filters match direct references only, not references mined from inputs.

`provenance` reads the object itself and works without activity support. Absent
objects return `undefined`; legacy objects return `{ kind: 'unknown' }`.
Provenance survives feed, operation, and receipt retention. These capabilities
are host-only; `as(principal)` does not expose historical data.

`operations(principal, { requestId, transport, executionId?, runtimeId? })`
binds trusted request context. Without it each call gets its own embedded
request ID. Each attempt always gets a fresh operation ID. Internal transports
can use `host.dispatch(principal, scope, method, args)` for a single dispatch
whose scope ID they assigned before routing; its actor is overwritten with the
authenticated principal. A scope is never a reusable consumer binding.

Configure capture with
`activity: { enabled, maxEntries, maxBytes, maxObjects, batchEntries, flushTimeoutMs, onError }`
on runtime creation or app setup. Defaults are enabled, 1,024 queued/in-flight
rows, 4 MiB, 1,000 lineage objects, 100 rows per append, and a 2-second shutdown
flush. Oversized lineage is marked with `details.truncated`.
`host.captureDiagnostics` reports dropped rows and omitted lineage objects;
`onError` receives sanitized codes/counts/kinds. Capture failure never changes a
consumer result; feed writes and provenance remain required when capture is
disabled. `close()` drains tracked calls, then flushes capture with the
configured deadline. Borrowed stores remain open.
