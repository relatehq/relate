# @relate/runtime

Embedded read execution with explicit source and storage contracts. Private and
unpublished.

`createRuntime` composes a compiled model, installed graph ID, optional storage
adapter, source bindings and an optional clock. Consumer `read` applies
default-deny policy, field groups, selection, freshness and evidence. Trusted
host `adopt` fetches a known source record ID and durably establishes
membership. It is not a consumer-authorized creation action.

`@relate/runtime/storage` is the supported adapter extension boundary. Storage
owns atomic observation acceptance through `ObservationStore`; the runtime owns
the shared pure ordering rule. Concrete adapters are injected, never imported.
Modules separate authorization, observation validation/ordering and resolution.

Reads retain successful source observations. Retention failure can return a
validated authorized transient value with explicit durability/ordering warnings;
it cannot renew permission evidence. Provider versions precede fetch-start
ordering. Without provider versions, order is best effort and cannot prove
upstream recency. Deletion and denial are never undone by fallback.

The source fetch wait defaults to 3 seconds (maximum 10 seconds), including
non-cooperative connectors. The Postgres adapter separately bounds pool, lock,
and statement waits; this is not a whole-request deadline guarantee. Connectors
must honor cancellation to stop their own outstanding I/O. Each read uses at
most one source fetch in this slice.

Only explicit shared service-account source bindings are supported. Delegated
credential partitions, automatic sync workers, arbitrary predicates, lists,
relationships and actions are not implemented. Consumer results remain partial
JSON records; generated selection inference is not implemented.

## Storage

Omit `store` for an isolated in-memory store with no database setup:

```ts
const runtime = createRuntime({ model, graphId, sources });
```

Supply `createMemoryStore()` from `@relate/runtime` to share memory between
runtimes, or a Postgres/custom `ObservationStore` for persistent retention.
Memory supports the same identity, ordering, authorization and fallback behavior
within its lifetime. It does not retain data across process restarts.

Field evidence separates write outcome (`retention`) from storage guarantee
(`retentionDurability: 'volatile' | 'persistent'`). Both built-in stores run the
same conformance suite. `pnpm test:unit` runs the memory and pure unit tests
without Postgres.

See [Writing a store](STORE_CONTRACT.md) for the public interface's behavioral
contract, errors, lifecycle and adapter verification requirements.
