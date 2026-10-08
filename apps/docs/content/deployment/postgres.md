# Persistence

By default the runtime uses an in-memory store, which loses adopted records,
observations, native records, and receipts when the process exits.

Durable persistence is provided by separate store packages. `@relate/postgres`
is the first available option; additional persistence packages are planned.

## Postgres

`@relate/postgres` stores the runtime state durably in PostgreSQL.

`@relate/postgres` is a private, unpublished development baseline
(`0.0.0-dev.0`). It is not ready for application use, and its APIs and behavior
may change without notice. Use it from a checkout of the Relate repository.

---

### Schema Isolation

Relate never modifies your application or source tables. It keeps its state in a
dedicated `relate` schema in an existing database:

```mermaid
flowchart TD
  database["PostgreSQL database"] --> relate["relate schema: managed by store.migrate()"]
  database --> public["public schema: application and source tables, untouched"]
  relate --> migrations["migrations: applied migrations and checksums"]
  relate --> graphs["graphs: graph IDs and definition revisions"]
  relate --> objects["objects: adopted objects, aliases, latest observations"]
  relate --> changes["value_changes: applied source value history"]
  relate --> native["native_objects: records written by actions"]
  relate --> invocations["native_invocations: action invocations and receipts"]
```

Relate does not create databases or start servers.

---

### 1. Connecting the Store

Create the store, migrate it, and pass it to the runtime:

```ts
import { createPostgresStore } from '@relate/postgres';
import { createRuntime } from '@relate/node';
import { connect } from 'relate';
import { addAccountReview } from './actions/add-account-review.server.js';
import { graph } from './graph.js';
import { Customer, billingInvoices, crmCustomers } from './model.js';
import { billingConnector, crmConnector } from './connectors.js';

const store = createPostgresStore({
  connectionString: process.env.DATABASE_URL!,
});

// Hosts migrate explicitly. Only the `relate` schema is created or changed.
await store.migrate();

// The store is borrowed: Relate neither migrates nor closes it.
const relate = createRuntime({
  graph,
  actionImplementations: [addAccountReview],
  store,
  connections: [
    connect(crmCustomers, {
      providerAccountId: 'crm-account',
      connectionId: 'crm-primary',
      connector: crmConnector,
    }),
    connect(billingInvoices, {
      providerAccountId: 'billing-account',
      connectionId: 'billing-primary',
      connector: billingConnector,
    }),
  ],
});

try {
  const id = await relate.host.adopt(Customer, 'crm_456');
  const customer = await relate
    .as({ id: 'ana', roles: ['employee'], claims: { portfolio: 'emea' } })
    .objects.Customer.get(id, { select: ['name'] });

  // Retained fields report retentionDurability: 'persistent'.
  if (customer.status === 'ok') console.log(customer.meta.fields.name);
} finally {
  await relate.close();
  await store.close();
}
```

- `createPostgresStore` is synchronous and opens connection pools lazily.
- `migrate()` must run before the runtime's first operation. It is safe to call
  on every start; it applies only missing migrations and verifies the checksums
  of applied ones.
- The host owns the store: close the runtime first, then the store.

The graph, connectors, and action come from
[Querying & Traversal](../runtime/reading-data.md) and
[Actions, Mutations & Receipts](../runtime/actions.md).

---

### 2. Definition Revision Pinning

Compiling a graph produces a manifest of its objects, properties, relationships,
policies, and actions, and a `definitionRevision` (`sha256:…`) computed over it.
`createRuntime` compiles the graph when it is created.

On its first operation, the runtime installs that revision for its graph ID
(`graphId`, which defaults to the graph's `id`). If the database already has a
**different** revision for that graph ID, older or newer, the operation fails:

```
Error: Installed model differs; explicit migration required
```

This prevents a changed graph from reading or writing data stored under another
definition. Any change that alters the manifest produces a new revision,
including renaming a property or tightening a policy.

Migrating stored data between definition revisions is not implemented yet.
During development, use a fresh database or a different `graphId` after changing
the graph.

---

### 3. Environment Configuration

The repository's examples and tests read connection strings from `.env` (see
[`.env.example`](../../../../.env.example)):

```sh
# The Postgres example applies migrations and keeps data in this database.
DATABASE_URL=postgresql://postgres:postgres@localhost:5433/relate

# Dedicated disposable database. Integration tests reset its relate schema.
RELATE_TEST_DATABASE_URL=postgresql://postgres:postgres@localhost:5433/relate_test
```

Integration tests use only `RELATE_TEST_DATABASE_URL` and refuse to run without
it; they never fall back to `DATABASE_URL`. They do not check what the URL
points to, so never point it at a database you want to keep.

To see adoption, refresh, restart, and durable fallback against a real database,
run the
[Postgres persistence example](../../../../examples/postgres-persistence/README.md):

```sh
pnpm example:postgres
```

The store's schema ownership, locking, and transaction semantics are documented
in [`packages/postgres/CONTRACT.md`](../../../../packages/postgres/CONTRACT.md).
