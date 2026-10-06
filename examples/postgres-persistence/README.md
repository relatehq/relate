# Postgres persistence

Shows how to supply a persistent store, refresh source data and recover retained
values after recreating the runtime and database connection. Start with
[Hello world](../hello-world/README.md) for the minimal in-memory example.

Run from the repository root:

```sh
pnpm install
DATABASE_URL=postgresql://localhost/relate_example pnpm example:postgres
```

Supply an existing Postgres database using `DATABASE_URL`; the URL includes the
database name. The connection role needs permission to create the `relate`
schema and its tables. Relate explicitly applies its migrations with
`store.migrate()`. It does not provision databases or manage the server.

The example starts an in-process Hono CRM simulator with a real HTTP listener.
It adopts one customer, reads as an employee, changes the CRM name, refreshes as
Finance, stops the CRM, recreates the embedded runtime and storage pool, and
reads the retained name. Finally it advances its controlled clock past the
permission evidence limit and demonstrates denied access. It closes its
connections and CRM listener on exit; the database and retained data remain
available.

- `src/model.ts`: authoring, stable IDs, source ownership, field groups, policy.
- `src/connector.ts`: the example's minimal HTTP source adapter.
- `src/index.ts`: embedded composition and the complete scenario.

`runtime.adopt(objectDefinitionId, sourceRecordId)` is a trusted host ingestion
operation. It fetches and validates a membership record before atomically
registering the canonical identity, source alias, retained record, projection,
and value history. Repeated adoption reuses the object ID. A consumer read never
adopts.

Hosts authenticate callers before supplying principal roles and claims. The
example uses explicit local principals. Employees see ordinary Customer fields;
Finance additionally sees revenue. Both must match the source-backed portfolio
policy, whose evidence expires after 30 seconds. Business freshness defaults to
60 seconds and is independently configurable.

The `shared-service` binding explicitly uses one provider account's visibility.
It does not implement delegated provider credentials. Connection identity is
part of retained storage scope; another account cannot reuse these values.

An unavailable source produces authorized stale fallback by default.
`stale: 'omit'` omits old values; `requireComplete: true` then errors when the
selection cannot be fulfilled. These options compose: completeness alone permits
stale data. Confirmed deletion and expired permission evidence withhold the
object.

Evidence distinguishes availability, freshness, source definition, observation
time, refresh outcome, ordering basis, and confirmed/failed/unconfirmed
retention. `retentionDurability: 'persistent'` distinguishes this store from the
default memory store. Observation time is conservatively the fetch-start time.
Returning a transient value after retention failure does not establish new
permission, advance durable ordering, or create durable value history. A
readback can resolve a lost commit acknowledgement. Public evidence excludes raw
records, source record IDs, connection credentials, and hidden field details.

With `RELATE_TEST_DATABASE_URL` set to a separate dedicated test database,
`pnpm test:integration` verifies this behavior against Postgres, including a new
plain Node process reading fallback after the source stops, concurrent
observations, transaction rollback, uncertain retention, and authorization
expiry.
