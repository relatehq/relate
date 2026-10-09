# Application Setup & Lifecycle

Use `defineApp` to keep the graph importable while deferring connections and
storage until startup. `startApp` executes that setup and returns the typed
runtime. The host owns its web server, authentication, and process signals.

## Define the App

This example uses a graph with one `customers` source backed by SQLite. The
source schema has string `id` and `name` fields. Add a binding for every source
and an implementation for every action registered in your graph.

```ts
// app.ts
import { connect, defineApp } from 'relate';
import { graph, customers } from './model.js';

export default defineApp({
  graph,
  async setup({ onDispose }) {
    const { sqlite } = await import('@relate/connector-sqlite');
    const database = sqlite({ path: './crm.sqlite' });
    onDispose(() => database.close());

    return {
      graphId: 'customer-directory',
      connections: [
        connect(customers, {
          connectionId: 'crm',
          connector: database.table('customers', {
            idColumn: 'id',
            columns: ['name'],
          }),
        }),
      ],
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
// Include store in the returned bindings, alongside connections and handlers.
```

The runtime borrows supplied stores and provider clients. `startApp` closes only
resources you register with `onDispose`; passing a store does not register it
automatically. If you call `createRuntime` directly, manage cleanup yourself:
close the runtime first, then its store and provider clients. Avoid closing a
shared resource while another runtime still uses it.

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

The [customer workspace](../../../../examples/03-customer-workspace/src/app.ts)
shows a complete app with source bindings, action implementations, and cleanup.
