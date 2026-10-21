# Runtime and Consumer API

Use `relate` for authoring and `@relate/node` to run the model. This reference
lists the application-facing entry points; the
[generated reference](./api/index.md) covers core authoring helpers and
request/result types.

## Runtime setup

```ts
import { createRuntime, startApp } from '@relate/node';

// graph, bindings and actionImplementations are your application bindings.
const runtime = createRuntime({ graph, bindings, actionImplementations });
// Alternatively, execute a defineApp descriptor's deferred setup:
const started = await startApp(app);
```

`createRuntime(options)` accepts the graph plus application bindings, including
an optional `graphId`, `store`, `cursorKey` and `activity` configuration.
`startApp(app)` runs setup and registers its disposal callbacks. Both return a
typed `Relate<G>` runtime. See [Application Setup](../runtime/application.md)
for resource ownership and [Persistence](../deployment/postgres.md) for stores.

For analytical graphs, setup may also return
`analytics: { operationTimeoutMs: 60_000, maxSourceCalls: 100_000, maxCandidatesScanned: 12_500, maxCandidatesAdmitted: 10_000 }`.
These defaults bound each analytical get or query page, including ordinary
source reads and nested authorization checks. Both provider identity checks and
fetch attempts count; cached application-identity reads do not. A caller's
`timeoutMs` can only shorten the operation deadline. Exhausting the source-call
budget rejects the request rather than returning stale fallback. See the
[Node contract](../../../../packages/node/CONTRACT.md#analytical-operation-limits)
for configuration, cancellation and validation limits.

| Runtime method                    | Result and purpose                                                                                                                                                                                      |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `as(principal)`                   | `Consumer<G>`: graph-typed, actor-bound object, action and receipt methods.                                                                                                                             |
| `operations(principal, context?)` | `ConsumerOperations`: the same actor-bound operations addressed by definition IDs, for transport hosts. Context carries request attribution, not an operation ID.                                       |
| `close()`                         | `Promise<void>`: reject new work, drain in-flight work, and flush captured operations within the configured deadline. Borrowed resources stay open; `startApp` also runs registered disposal callbacks. |

The host authenticates the principal. Neither facade grants access beyond the
model's policies. Source:
[Relate interface](../../../../packages/node/src/types.ts).

## Typed consumers

```ts
const consumer = runtime.as(principal);
const customer = await consumer.objects.Customer.get(customerId, {
  select: ['name'],
});
const page = await consumer.objects.Invoice.query({ limit: 25 });
```

Registry keys such as `Customer` and `addAccountReview` determine method names.
The following names illustrate a graph that defines those objects and actions.

| Method                                                | Result                                                                |
| ----------------------------------------------------- | --------------------------------------------------------------------- |
| `consumer.describe()`                                 | Actor-visible graph overview and SDK guidance.                        |
| `objects.Customer.describe()`                         | Object detail, or `undefined` when undiscoverable.                    |
| `objects.Customer.get(id, options?)`                  | Promise of an `ok` or `not-found` object result.                      |
| `objects.Customer.query(options?)`                    | Lazy `QueryResult`: await a page or asynchronously iterate records.   |
| `objects.Customer.traverse.invoices(id, options?)`    | To-many: lazy `QueryResult`; accepts filters and pagination.          |
| `objects.Invoice.traverse.customer(id, options?)`     | To-one: promise of an object result; no filters or pagination.        |
| `actions.addAccountReview({ input, idempotencyKey })` | Promise of a typed success or declared-failure receipt.               |
| `actions.addAccountReview.describe()`                 | Action detail, or `undefined` when undiscoverable.                    |
| `receipts.get('addAccountReview', invocationId)`      | Promise of the actor-bound receipt, subject to current access checks. |

Reads default to compact evidence and optional data fields. Request
`evidence: 'full'` for every selected field's provenance and freshness. See
[Reading Data](../runtime/reading-data.md), [Actions](../runtime/actions.md),
[Discovery](../runtime/discovery.md), and [Read Responses](./read-responses.md).

For custom consumer integrations, `createConsumer(description, operations)` from
`relate/consumer` builds this facade from a `ConsumerDescription<G>` and
`ConsumerOperations`. It verifies graph identity and definition revision at
construction; the operations implementation must keep requests bound to the same
model and actor. Ordinary embedded applications use `runtime.as(principal)`.
Source:
[consumer exports and interfaces](../../../../packages/relate/src/consumer.ts).

## Decoding computed values

`decodeComputed` from `relate/consumer` returns a separate bag of computed
values using `record.meta.computed`. It works for get results and individual
query records, with compact or full evidence:

```ts
import { decodeComputed } from 'relate/consumer';

const record = await consumer.objects.Customer.get(customerId, {
  compute: { logins: { sql: 'SELECT COUNT(*) FROM self.events' } },
});
const fields = decodeComputed(record);
// fields.logins is 2n if the response returned "2".
```

| Logical type           | Decoded value                                   |
| ---------------------- | ----------------------------------------------- |
| int64                  | `bigint`                                        |
| timestamp, precision 3 | `Date`                                          |
| timestamp, precision 6 | Canonical UTC string, preserving all six digits |
| int32, float64         | `number`                                        |
| string, boolean        | Unchanged scalar                                |
| SQL null               | `null`                                          |

Caller aliases and declared calculations use the same path. Missing values stay
missing; ordinary fields are excluded. The input record and evidence remain
unchanged. A not-found result or absent computed metadata returns `{}`. For a
page, use `page.data.map(record => decodeComputed(record))`.

Fields remain optional in the `DecodedComputed<R>` return type. Literal metadata
can narrow the value type; authored SQL needs runtime type checks, such as
`typeof fields.logins === 'bigint'`. Invalid present values or their metadata
throw `AnalyticalValueError` from `relate/analytics`, without disclosing values.
The decoded bag is for local use; retain the original record for JSON transport.

## Trusted host APIs

These APIs are available on `runtime.host`, outside consumer authorization. Do
not expose them as consumer routes or MCP tools.

| Method                                                         | Result and purpose                                                                                                                                   |
| -------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `adopt(Object, sourceRecordId, attribution?)`                  | Promise of a branded object ID. Attribution optionally supplies `actor` and request `context`; the default actor is the system `relate.host`.        |
| `activity.status()`                                            | Activity support, durability and operation-capture status.                                                                                           |
| `activity.feed.read(options?)`                                 | Oldest-first page of atomically committed changes and invocation events.                                                                             |
| `activity.operations.list(options?)`                           | Newest-first page of best-effort operation history.                                                                                                  |
| `provenance({ objectDefinitionId, objectId })`                 | Creation/adoption attribution, `{ kind: 'unknown' }` for legacy records, or `undefined` for an unknown object.                                       |
| `activityCounters()`                                           | Cumulative capture drop and truncation counters.                                                                                                     |
| `flushActivity()`                                              | Promise of `'flushed'` or `'pending'`: wait up to `activity.flushTimeoutMs` for captured rows to be appended or dropped. Does not stop new work.     |
| `dispatch(principal, { operationId, context? }, method, args)` | Run one consumer method under a transport-assigned, fresh UUIDv7 operation ID. The principal supplies the actor. Discovery is not a dispatch method. |

Feed and operation pages have `{ entries, nextCursor, hasMore }`. Start with
`{ filter?, limit? }`, then continue with `{ cursor, limit? }`; filters and
cursors cannot be supplied together. Feed cursors advance over scanned entries
even when a filter returns no matches. These differ from consumer query pages.

See [Activity & Provenance](../runtime/activity.md) for filter options,
checkpointing, atomicity, retention, capture configuration and rejection codes.
The exact types live in the
[host interface](../../../../packages/node/src/types.ts) and
[activity protocol](../../../../packages/protocol/src/activity.ts).
