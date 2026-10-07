# Postgres persistence

Shows how to supply a persistent store, refresh source data and recover retained
values after recreating the runtime and database connection. Start with
[Hello world](../hello-world/README.md) for the minimal in-memory example.

Run from the repository root:

```sh
pnpm install
# On first setup, copy .env.example to .env and configure existing databases.
pnpm example:postgres
```

The command loads the repository's `.env` with dotenvx. Supply an existing
Postgres database using `DATABASE_URL`; the URL includes the database name. The
connection role needs permission to create the `relate` schema and its tables.
Relate explicitly applies its migrations with `store.migrate()`. It does not
provision databases or manage the server.

The example starts an in-process Hono CRM simulator with a real HTTP listener.
It adopts one customer, reads as an employee, changes the CRM name, refreshes as
Finance, has the CRM deny record access and shows a refused refresh next to a
cached read, then disables CRM record fetching while leaving account
verification available. It recreates the embedded runtime and storage pool and
reads the retained name. Finally it advances its controlled clock past the
permission evidence limit and demonstrates expired Relate permission evidence.
It closes its connections and CRM listener on exit; the database and retained
data remain available.

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
It does not implement delegated provider credentials. Connection identity and
the verified `providerAccountId` are part of retained storage scope. The
connector's `identify()` checks the active provider account before cached reads;
each fetched record also carries account identity. Reusing a connection ID for
another account cannot read or refresh the earlier account's object IDs. A
configured account ID alone is not evidence: connectors must obtain identity
from the provider using the credentials used for record access.

The connector maps record responses onto the runtime's three outcomes: a
`deleted` body is a confirmed deletion, HTTP 401/403 throws
`SourceAccessDenied`, and any other failure is temporary unavailability. A
denied refresh returns `not-found` with no fallback. Record denial is observed
per read rather than persisted: the retained observation remains. While data and
permission evidence are fresh, a cached read verifies account identity but does
not fetch the record, so it still returns the retained value. Request `refresh`
of source-backed fields when a current record-access check is required.

An unavailable record endpoint produces authorized stale fallback by default
only while provider account identity can still be verified. If identity
verification fails or times out, reads throw `ReadError('unavailable')` without
cached data. Account mismatch returns `not-found`; adoption rejects.
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

With `RELATE_TEST_DATABASE_URL` in `.env` set to a separate dedicated test
database, `pnpm test:integration` verifies this behavior against Postgres,
including a new plain Node process reading fallback during a record-endpoint
outage, concurrent observations, transaction rollback, uncertain retention, and
authorization expiry.
