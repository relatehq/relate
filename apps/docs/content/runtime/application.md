# Application Setup & Lifecycle

Use `defineApp` to keep the graph importable while deferring bindings and
storage until startup. `startApp` executes that setup and returns the typed
runtime. The host owns its web server, authentication, and process signals.

## Define the App

This example uses a graph with one `customers` source backed by SQLite. The
source schema has string `id` and `name` fields. Add a binding for every source
and an implementation for every action registered in your graph.

```ts
// app.ts
import { bind, defineApp } from 'relate';
import { graph, customers } from './model.js';

export default defineApp({
  graph,
  async setup({ onDispose }) {
    const { sqlite } = await import('@relate/connector-sqlite');
    const database = sqlite({ connectionId: 'crm', path: './crm.sqlite' });
    onDispose(() => database.close());

    return {
      graphId: 'customer-directory',
      bindings: [bind(customers, database.table('customers'))],
    };
  },
});
```

`defineApp` starts nothing. Each `startApp(app)` runs setup once for that
runtime. Register cleanup immediately after acquiring each resource so a later
setup or compilation failure can release it. Disposers run in reverse
registration order; all are attempted even if one fails.

## Start and Stop

```ts
// main.ts
import { startApp } from '@relate/node';
import app from './app.js';

const relate = await startApp(app);
try {
  // Supply this runtime to your application routes or other host code.
  // Authenticate each caller before constructing relate.as(principal).
} finally {
  await relate.close();
}
```

For a server, keep the runtime alive while serving requests. On shutdown, stop
accepting application requests, drain their work, and close the runtime.
`relate.close()` rejects new runtime operations, waits for in-flight operations,
then runs the app's registered disposers. `startApp` does not install signal
handlers or start an HTTP/MCP server for you.

## Storage Ownership

Omitting `store` gives each runtime an isolated in-memory store. To retain
identities, observations, native records, and receipts across restarts, create
and migrate a [Postgres store](../deployment/postgres.md) during setup:

```ts
// Inside setup({ onDispose }), before returning bindings:
const { createPostgresStore } = await import('@relate/postgres');
const store = createPostgresStore({
  connectionString: process.env.DATABASE_URL!,
});
onDispose(() => store.close());
await store.migrate();
// Include store in the returned bindings, alongside bindings and handlers.
```

The runtime borrows supplied stores and provider clients. `startApp` closes only
resources you register with `onDispose`; passing a store does not register it
automatically. If you call `createRuntime` directly, manage cleanup yourself:
close the runtime first, then its store and provider clients. Avoid closing a
shared resource while another runtime still uses it.

`close()` rejects new operations, waits for in-flight work, then flushes
captured operation rows within `activity.flushTimeoutMs`. Rows still queued at
the deadline are reported as dropped. Use `host.flushActivity()` to wait for
captured rows without closing the runtime. See
[Activity & Provenance](./activity.md) and the
[Runtime and Consumer API](../reference/runtime-api.md).

The installation's `graphId` defaults to the graph definition's `id`. Persistent
installations pin a definition revision. Changing the model requires a new
development installation or an explicit migration; revision migrations are not
implemented yet.

## Keep Definitions Safe to Inspect

Point `relate.config.ts` at the graph or app descriptor:

```ts
export { default } from './app.js';
```

The [Inspector](../authoring/inspector.md) imports this entry and its
dependencies but never calls `setup`. Keep database opening, credential loading,
server startup, and queries inside setup or the host entry point. An import with
top-level side effects still executes during inspection.

The [customer workspace](../../../../examples/02-customer-workspace/src/app.ts)
shows a complete app with source bindings, action implementations, and cleanup.

## Analytical declaration validation

`startApp` initializes the SQL parser for graphs containing datasets or
`computed(...)` properties. It validates every declared calculation before
serving, including calculations that have not been selected or are restricted by
field access. Invalid SQL, unknown names, incompatible types, named parameters
and references to other computed properties fail startup with a `CompileError`
pointing to the authored property. Registered resources are disposed on failure.

Graphs containing datasets use `startApp` so it can inspect every physical table
before returning a runtime. Each dataset needs a binding, such as
`bind(Events, analytics.table('events'), { columns: { customerId: 'customer_id' } })`.
Columns not listed in the mapping keep their declared names. Missing columns,
incompatible logical types or timestamp precision, and nullable columns used for
non-null declarations fail startup. All registered datasets are checked, even
when no calculation references them.

`createRuntime` remains synchronous for ordinary graphs. For analytical graphs,
use `startApp(defineApp({ graph, setup }))`; no separate readiness call is
needed. SQLite analytical execution and object `get`/`query` support caller SQL
and selected declared calculations:

```ts
const customer = await ana.objects.Customer.get(customerId, {
  select: ['name', 'loginCount'],
  compute: {
    latestEvent: { sql: 'SELECT MAX(occurredAt) FROM self.events' },
  },
  evidence: 'full',
});
```

This assumes `Customer` declares the `events` association and `loginCount`
calculation. Aliases add fields independently of `select` and cannot collide
with any property. Both forms share the host expression limit (eight by
default). Int64 values, including counts, are JSON strings; `meta.computed`
describes each projected result in both evidence modes. Missing or forbidden
values remain omitted.

The runtime reads ordinary dependencies, executes against the dataset, then
rechecks object access and dependency values. Changed or unusable inputs
withhold the affected result; no automatic recomputation occurs. Full computed
evidence contains dependency evidence, never unselected dependency values or
SQL. Dataset freshness is `unverified`; freshness options and object policy
evidence limits apply to ordinary dependencies. Caller timeout and runtime
shutdown fail the whole read after analytical statement cleanup.

For a query without computed filters or ordering, ordinary authorization and
property filters select the page first. The runtime computes all page members
together, with one statement per association and batch, then revalidates them
before returning the page. An ordinary filter whose value changed is checked
again. Failed analytical aliases are withheld across the whole evaluated page,
including earlier successful batches. `requireComplete` fails the query if a
returned record has omissions.

```ts
const page = await ana.objects.Customer.query({
  select: ['name', 'loginCount'],
  where: { status: 'active' }, // an ordinary property filter
  compute: { latestEvent: { sql: 'SELECT MAX(occurredAt) FROM self.events' } },
  limit: 25,
});
```

Continuation cursors bind the compute map, parameter values, selected fields and
dataset binding revisions alongside the ordinary query scope. Evidence mode may
change between pages. A cursor from a different expression or binding is
rejected. Empty pages may still have a continuation when final checks withhold
their members. Typed page reads and iteration preserve the alias result types.

Both SQLite and the
[PostgreSQL analytical connector](../../../../connectors/postgres/README.md)
execute these reads. [Discovery](./discovery.md#analytical-metadata) describes
actor-visible associations and calculated properties through the same consumer,
MCP and Inspector playground paths. Traversal and action transaction readers
reject analytical requests.

Use [`decodeComputed`](../reference/runtime-api.md#decoding-computed-values)
from `relate/consumer` to decode present calculated values using
`meta.computed`. It returns a separate bag, preserving missing fields and SQL
nulls without changing the read's data or evidence.

### Filtering and ordering by calculations

```ts
const page = await ana.objects.Customer.query({
  select: ['name'],
  where: { loginCount: { gte: '1' } },
  orderBy: [{ field: 'loginCount', direction: 'desc' }],
  limit: 25,
});
```

Here `loginCount` is a declared calculation. It is used to choose the page but
is returned only if selected. Caller aliases declared in `compute` can also be
used in `where` and `orderBy`, and are always returned. TypeScript rejects
undeclared aliases and ordinary property ordering.

These queries evaluate the whole authorized ordinary-filter scope before
choosing a page. Every filter/order calculation must succeed across that scope,
including objects outside the final page. Missing or changed dependencies fail
with `incomplete`; there is no automatic recomputation. Objects that are no
longer visible are withheld. Dependencies are checked across the scope and again
for the selected page.

Computed null never matches a filter and sorts last in both directions. Ties use
object ID ascending. Int64 bounds are decimal strings and comparisons remain
exact. Each page repeats enumeration and computation; the encrypted cursor
resumes after the previous ordering values and ID. Changing data between pages
can move objects across that position.

Host setup can bound this work with `analytics`: the default scan cap is 12,500
members and the admission cap is 10,000 ordinary matches. Both reject before SQL
when exceeded. A 100,000 source-call budget and 60,000 ms deadline cover the
whole operation, including final checks. Scope-first capacity and refresh runs
exercise these defaults at 100,000 events; deployments still require their own
capacity validation.

Preparation, batching and connection admission can also be configured:

```ts
return {
  bindings,
  analytics: {
    maxSqlBytes: 4096,
    maxParsedNodes: 256,
    maxParameters: 16,
    maxParameterBytes: 1024,
    maxExpressions: 8,
    maxKeysPerStatement: 1000,
    statementTimeoutMs: 5000,
    maxConcurrentStatements: 4,
    maxQueuedStatements: 32,
    queueTimeoutMs: 2000,
  },
};
```

These are the defaults. Declaration validation, discovery and caller expressions
use the same preparation limits. Queues are shared by all actors and bindings on
each configured connection, and capacity is released after statement cleanup. A
statement timeout starts after connector startup; the whole-operation deadline
continues to cover queueing, startup and revalidation. See the
[Node contract](../../../../packages/node/CONTRACT.md#analytical-operation-limits).

Run the
[customer events example](../../../../examples/04-customer-events/README.md)
with `pnpm example:customer-events` to try caller expressions, declared
calculations, computed filtering and ordering, and actor-specific column access
using one SQLite file.
