# @relate/runtime

The execution engine: authorized reads, traversal and native actions over a
compiled model, with explicit storage and connector contracts. Private and
unpublished.

## Responsibility

- `createRuntime({ model, graphId, sources, store?, actionHandlers?, … })`
  returns an engine with the trusted host operation `adopt` and the consumer
  operations `read`, `traverse` and `invoke`.
- Default-deny policy evaluation, field groups, selection, freshness, stale
  fallback and per-field evidence.
- Observation validation and the pure ordering rule (`compareObservation`).
  Storage owns atomic acceptance; the runtime owns the rule.
- `createMemoryStore()` for volatile storage and `createQuery()` for lazy,
  awaitable pagination.
- `@relate/runtime/storage`: the adapter extension boundary. `ObservationStore`,
  `NativeStore`, `NativeTransaction` and their errors are the contract that
  `@relate/postgres` and custom stores implement.

The engine is addressed by definition IDs and returns partial JSON records. It
does not compile graphs, is not the typed application API, and never imports a
concrete store or connector.

## How it fits

- Depends on `relate/model` (manifest types) and `@relate/protocol` (results).
  It never imports the authoring API.
- Storage adapters implement `@relate/runtime/storage` and are injected.
  Connectors implement `SourceConnector`; shared service authorization is the
  only supported mode in this slice.
- `@relate/node` composes this engine with an authored graph and adds types. The
  planned `@relate/http` and `@relate/mcp` expose the same consumer operations
  remotely.

## Public API

```ts
import { compile } from 'relate/compiler';
import { createRuntime, SourceAccessDenied } from '@relate/runtime';
import type { SourceConnector } from '@relate/runtime';

// A connector fetches one source record by its external ID.
const crm: SourceConnector = {
  async fetch(sourceRecordId, { signal }) {
    const response = await fetch(`${CRM_URL}/customers/${sourceRecordId}`, {
      signal,
    });

    if (response.status === 403) throw new SourceAccessDenied();
    if (response.status === 404) return { state: 'deleted' };

    return { state: 'present', record: await response.json() };
  },
};

const runtime = createRuntime({
  model: compile(graph), // authored with `relate`
  graphId: 'business',
  sources: {
    'crm.customers': {
      connectionId: 'crm-primary',
      authorization: 'shared-service',
      connector: crm,
    },
  },
  // store: omit for an isolated memory store, or inject a Postgres store.
});

// Trusted host operation: establish membership for a known source record.
const id = await runtime.adopt('business.customer', 'crm_456');

// Consumer operation: the host has already authenticated the principal.
const ana = { id: 'ana', roles: ['sales'], claims: { region: 'emea' } };
const result = await runtime.read(ana, 'business.customer', id, {
  select: ['name', 'region'],
});

if (result.status === 'ok') {
  result.data; // { name?: Json; region?: Json }: fields can be withheld
  result.meta.fields.name; // FieldEvidence: freshness, retention, ordering
}
```

## Status

Implemented: authorized reads, source-backed references, bidirectional traversal
with pagination, and synchronous native actions with atomic receipts on memory
and Postgres. Not implemented: automatic synchronization, delegated credentials,
collection queries, durable pending execution, receipt lookup and replay.

## Further reading

- [CONTRACT.md](./CONTRACT.md): read semantics, storage, pagination and native
  action behavior in detail.
- [STORE_CONTRACT.md](./STORE_CONTRACT.md): how to write and verify a storage
  adapter.
- [Native actions](../node/NATIVE_ACTIONS.md): the end-to-end action path.
