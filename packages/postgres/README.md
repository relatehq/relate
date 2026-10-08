# @relate/postgres

> Development baseline (`0.0.0-dev.0`), for discussion and contribution only.
> Not ready for application use. APIs and behavior are incomplete and may change
> without notice.

Durable Relate storage on PostgreSQL: the persistent `ObservationStore` and
`NativeStore` adapter, with checksummed migrations. Private and unpublished.

## Responsibility

- `createPostgresStore({ connectionString })` returns a store with `migrate()`,
  the runtime's observation storage contract, the optional `native` transaction
  capability and `close()`.
- Owns the `relate` schema: installed graph revisions, canonical identities and
  source aliases, latest observations and mapped values, applied-value history,
  native objects and action invocations. It never modifies provider tables.
- Atomic observation acceptance under per-alias locks, native transactions
  serialized per graph, explicit pool, lock and statement timeouts, and honest
  failure signalling: `StorageUnavailable` for confirmed failure,
  `NativeCommitUncertain` for a lost COMMIT acknowledgement.

It does not create databases or start servers. Hosts supply an existing database
and call `migrate()` explicitly.

## How it fits

- Implements `@relate/runtime/storage`. Imports `relate/model` for canonical
  JSON and `pg` for connections.
- Injected into `@relate/runtime` or `@relate/node`; the runtime never imports
  it. `createMemoryStore()` from `@relate/runtime` is the volatile alternative,
  and both pass the same conformance suite.
- Separate from connectors (see [`connectors/`](../../connectors/README.md)),
  which talk to providers rather than storing Relate state.

## Public API

```ts
import { createPostgresStore } from '@relate/postgres';
import { createRuntime } from '@relate/node';

const store = createPostgresStore({
  connectionString: process.env.DATABASE_URL!,
});

// Hosts migrate explicitly. Only the `relate` schema is created or changed.
await store.migrate();

// The store is borrowed: Relate neither migrates nor closes it.
const relate = createRuntime({ graph, connections, store });

try {
  const id = await relate.host.adopt(Customer, 'crm_456');
  const customer = await relate
    .as(ana)
    .objects.Customer.get(id, { select: ['name'] });

  // Retained fields report retentionDurability: 'persistent' in their evidence.
  if (customer.status === 'ok') console.log(customer.meta.fields.name);
} finally {
  await relate.close();
  await store.close();
}
```

The same store works with the engine directly:
`createRuntime({ model, graphId, sources, store })` from `@relate/runtime`.

Source observation values and `relate.value_changes.values` use stable property
IDs, as native records already do. Manifest format 3 changes the definition
revision and refuses existing name-keyed installations until explicitly
migrated. `migrate()` does not convert graph data or activate a new model
revision; see
[property identity](../runtime/STORE_CONTRACT.md#property-identity).

## Provider account migration

Migration 3 adds provider account identity to source aliases and lookup scope.
Existing observations lack verified provenance: the migration preserves them and
their history with a null account ID, inaccessible through scoped reads. It does
not infer an account from `connectionId` or current credentials. Re-adopting
through a verified connector establishes a new object ID; old references need
explicit reconciliation. No automatic reassignment or deletion is performed.

## Status

Implemented: durable source observations with history, installed-revision
pinning, and native transactions for the account-review action path. Not
implemented: history query APIs, retention and cleanup scheduling, erasure, and
model migrations between definition revisions.

## Further reading

- [CONTRACT.md](./CONTRACT.md): schema ownership, ordering, locking, timeouts
  and native transaction semantics.
- [STORE_CONTRACT.md](../runtime/STORE_CONTRACT.md): the adapter contract this
  package implements.
- [Postgres persistence example](../../examples/04-postgres-persistence/README.md):
  adoption, refresh, restart and durable fallback against a real database.
