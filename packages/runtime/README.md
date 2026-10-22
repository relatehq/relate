# @relate/runtime

> Development baseline (`0.0.0-dev.0`), for discussion and contribution only.
> Not ready for application use. APIs and behavior are incomplete and may change
> without notice.

The execution engine: authorized reads, queries, traversal and native actions
over a compiled model, with explicit storage and connector contracts. Private
and unpublished.

## Responsibility

- `createRuntime({ model, graphId, sources, store?, actionHandlers?, … })`
  returns an engine with the trusted host operation `adopt` and the consumer
  operations `read`, `query`, `traverse` and `invoke`.
- Default-deny policy evaluation, field groups, selection, freshness, stale
  fallback and per-field evidence.
- Observation validation and the pure ordering rule (`compareObservation`).
  Storage owns atomic acceptance; the runtime owns the rule.
- `createMemoryStore()` for volatile storage.
- `createDiscovery(model, principal, parser?)` returns a compact, complete graph
  overview with authorized traversal links and SDK guidance, plus on-demand
  object/action detail. The separate `operationContracts` export and its
  `OperationContract` / `OperationContracts` types retain the full read guide.
  Discovery metadata is actor-bound and uses `@relate/protocol` shapes.
  Analytical models supply the initialized SQL parser (the Node host supplies it
  automatically). Discovery reuses association/column authorization and
  declared-expression preparation to infer logical types without executing SQL.
  Hidden associations and properties are omitted, denied columns are marked, and
  authored calculation SQL is never disclosed.
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
- `@relate/node` composes this engine with an authored graph, binds it to the
  `ConsumerOperations` contract per principal and adds the `relate/consumer`
  facade. The implemented `@relate/mcp` serves the same contract remotely; the
  standalone `@relate/http` adapter remains planned. Lazy pagination
  (`createQuery`) lives in `relate/consumer`, not here.

## Public API

```ts
import { compile } from 'relate/compiler';
import { createRuntime } from '@relate/runtime';
import { SourceAccessDenied } from 'relate/connectors';
import type { SourceConnector } from 'relate/connectors';

// This provider returns account identity with every authenticated record response.
const crm: SourceConnector = {
  async identify({ signal }) {
    const response = await fetch(`${CRM_URL}/account`, { signal });
    if (response.status === 401 || response.status === 403)
      throw new SourceAccessDenied();
    if (!response.ok) throw new Error('Identity unavailable');
    return (await response.json()).id;
  },
  async fetch(sourceRecordId, { signal }) {
    const response = await fetch(`${CRM_URL}/customers/${sourceRecordId}`, {
      signal,
    });

    if (response.status === 401 || response.status === 403)
      throw new SourceAccessDenied();
    if (!response.ok) throw new Error('CRM unavailable');

    // { providerAccountId, state: 'present', record } or
    // { providerAccountId, state: 'deleted' } with affirmative deletion evidence.
    return response.json();
  },
};

const runtime = createRuntime({
  model: compile(graph), // authored with `relate`
  graphId: 'business',
  sources: {
    'crm.customers': {
      connectionId: 'crm-primary',
      resourceId: 'records',
      providerAccountId: 'provider-account-123',
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
  result.meta.fields?.name; // Exceptional evidence; routine evidence is omitted
}
```

For provider-verified connectors, account identity is checked even for cached
reads. Both `identify()` and fetch response identity must describe the
authenticated provider account, never just repeat the configured expected ID. If
identity cannot be verified, reads fail without cached data. See
[the connector contract](./CONTRACT.md) for account rotation, stale fallback and
adapter trust requirements.

Connectors can instead explicitly implement `ApplicationSourceConnector` with
`identity: 'application'` and `fetch()`, omitting `identify()` and account IDs.
The binding then needs only `connectionId`, `authorization` and `connector`. The
host must change `connectionId` for a different logical source; Relate cannot
detect replacement under the same ID. SQLite defaults to this mode. Application
identity and verified accounts never share retained observations.

Explicitly selecting a known field without its field-group permission returns
`{ status: 'forbidden' }`. If a permitted value cannot be supplied, for example
after a failed refresh with `stale: 'omit'`, it returns
`{ status: 'unavailable' }`. Unknown selections also remain `unavailable`.

```ts
const financial = await runtime.read(ana, 'business.customer', id, {
  select: ['revenue'],
});

if (financial.status === 'ok') {
  financial.meta.fields?.revenue; // { status: 'forbidden' }
  // completeness: 'partial', degraded: false (if otherwise healthy)
}
```

Both missing statuses fail `requireComplete: true`. Permission-only omissions do
not mark a read degraded. Whole-object denial remains `not-found`, and neither
missing status exposes policy or provider evidence.

## Activity

Every consumer and host call is one operation. The engine records committed
changes and invocation events in the store's feed atomically with the state they
describe, and enqueues one best-effort operation row per call once it settles.
Trusted hosts read them through `runtime.activity` and `runtime.provenance`;
neither is exposed to consumers.

```ts
const runtime = createRuntime({
  model,
  graphId: 'business',
  sources,
  activity: { operations: 'enabled', queueEntries: 1_000 },
});

const batch = await runtime.activity.feed.read({ limit: 100 });
const page = await runtime.activity.operations.list({
  filter: { kinds: ['refresh'] },
});
const provenance = await runtime.provenance({
  objectDefinitionId: 'business.customer',
  objectId: id,
});

// Before discarding the engine: flush queued operation rows within a deadline.
await runtime.drainActivity(5_000);
```

Engine methods accept an optional trailing `OperationScope` from
`createOperationScope(actor, context)`; its actor must be the call's principal
(or, for `adopt`, the host actor). Without one, each call gets a fresh operation
and request ID. Inside the engine, this scope is required and passed explicitly
through reads, queries, traversals, action execution and authorization evidence
resolution. Each source refresh derives its child scope from that argument;
there is no ambient context or fallback actor. Action execution returns its
receipt and replay flag together for capture. The public result remains the
receipt alone. Transport/IPC boundaries must pass their trusted scope
explicitly.

Activity representation lives in `src/activity/`: `descriptions.ts` maps settled
consumer, adoption and refresh results to metadata-only operation bodies,
`capture.ts` adds timing and identity, and `feed.ts` builds native
invocation/change drafts. Resolution supplies adoption failure classification;
activity never imports execution modules. The composition root wires these
helpers to execution. Queries and traversals depend on activity only for the
scope type. Native execution still stages feed drafts inside its transaction,
and storage adapters retain responsibility for atomic publication and
source-change classification.

Analytical `get` and membership-first `query` operations add
`details.analytical.stages` to enabled activity capture. Each entered stage has
`{ count, totalMs, maxMs }`, measured monotonically and closed on success or
failure, including connector cancellation cleanup. These are summed work
durations that can overlap; use the operation's `durationMs` for elapsed time.
Only fixed stage names and numbers are retained. Consumer metadata, evidence,
discovery and MCP results do not contain these diagnostics.

Capture limits default to 1,000 queued operations, 8 MiB queued, 100 per append,
1,000 lineage entries and 256 KiB per operation. See
[Activity & Provenance](../../apps/docs/content/runtime/activity.md) and the
[store contract](./STORE_CONTRACT.md#activity-capability).

## Status

Implemented: authorized reads and graph queries, source-backed references,
bidirectional traversal with pagination, and synchronous native actions with
atomic success or declared-failure receipts on memory and Postgres. Not
implemented: automatic synchronization, delegated credentials, provider-wide
queries and durable pending execution. Receipt lookup and same-key replay are
implemented with originating-actor and current-access checks. The activity feed,
best-effort operation capture and object provenance are implemented on memory
and Postgres; feed and operation pruning are not.

## Further reading

- [CONTRACT.md](./CONTRACT.md): read semantics, storage, pagination and native
  action behavior in detail.
- [STORE_CONTRACT.md](./STORE_CONTRACT.md): how to write and verify a storage
  adapter.
- [Native actions](../node/NATIVE_ACTIONS.md): the end-to-end action path.

## Internal ownership

`pnpm check:boundaries` checks runtime dependencies as well as package imports.
Cross-module imports use the owning module's `index.ts`, including type imports.
New top-level modules need an explicit owner in the checker.

| Module                          | Owns                                                                      | Runtime dependencies                                            |
| ------------------------------- | ------------------------------------------------------------------------- | --------------------------------------------------------------- |
| `runtime.ts`                    | Validated composition, installation, source/native routing                | Operation entry points, storage contracts, default memory store |
| `analytical-reads/`             | Analytical request preparation, execution orchestration and revalidation  | Authorization, queries, read helpers, analytics, activity       |
| `analytics/`                    | Expression preparation, batching, execution and computed-value validation | No other runtime modules                                        |
| `discovery/`                    | Actor-visible descriptions and operation contracts                        | Authorization, actions, traversal, read helpers, analytics      |
| `resolution/`                   | Source reads, adoption, refresh and retention recovery                    | Authorization, observations, read helpers, storage contracts    |
| `actions/`                      | Native reads/creation, action execution and deadlines                     | Authorization, read helpers, storage contracts                  |
| `traversal/`                    | Reference traversal, bounded enumeration and cursors                      | Authorization, read helpers, storage contracts                  |
| `authorization/`                | Policy evaluation and reference visibility                                | Storage types only                                              |
| `observations/`                 | Fetch validation, ID-keyed mapping and pure ordering                      | Storage types only                                              |
| `reads/`                        | Request validation and field-evidence summaries                           | No other runtime modules                                        |
| `storage.ts`                    | Adapter capabilities and errors                                           | Pure observation ordering re-export only                        |
| `memory.ts`, `native-memory.ts` | In-memory implementations                                                 | Storage contracts and pure ordering                             |

Composition injects read and evidence-resolution callbacks. Actions and
traversal cannot import source resolution, and authorization cannot fetch data
or import operation implementations. Pure ordering is the only observation
implementation exposed to storage; storage never imports the fetch barrel. The
checker rejects reverse dependencies, private cross-module imports and execution
cycles, including literal dynamic imports. Type-only cycles between observation
algorithms and storage contracts are allowed.

Reads default to compact evidence. Pass `evidence: 'full'` for every selected
field's provenance. See the
[response reference](../../apps/docs/content/reference/read-responses.md).
