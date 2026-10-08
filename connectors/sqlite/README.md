# @relate/connector-sqlite

Read an existing SQLite database as a Relate source. This is a provider
connector, separate from the storage adapter used to persist Relate observations
and actions. Requires Node.js 26.9 or later in the 26.x line; uses built-in
`node:sqlite`.

```ts
import { sqlite } from '@relate/connector-sqlite';
import { connect } from 'relate';

const database = sqlite({
  path: './crm.sqlite',
});
const binding = connect(customers, {
  connectionId: 'local-crm',
  connector: database.table('customers', {
    idColumn: 'id',
    columns: ['display_name', 'portfolio', 'stripe_customer_id'],
  }),
});
// In defineApp.setup: onDispose(() => database.close()).
```

`customers` is your `defineSource(...)` definition. Its `idField` must match
`idColumn`, which is automatically included in the result. `columns` explicitly
selects the other fields to expose; unlisted columns are not read or retained in
Relate. Selected columns must exist. Configured names become result keys, even
when their casing differs from SQLite's declared identifiers.

The resource needs unique TEXT IDs. Matching uses binary equality and TEXT
storage class, so `abc` and `ABC` are distinct even on a NOCASE column, and
numeric values are not aliases for string IDs. Numeric-affinity key declarations
(such as `INTEGER PRIMARY KEY`) raise a configuration error. Untyped columns,
BLOB-affinity columns and views may supply TEXT IDs. If there is no exact TEXT
match, the connector checks for non-TEXT key values before reporting `deleted`;
any such value raises an error instead. This conservative absence check may scan
the resource. Existing exact TEXT matches in mixed columns remain readable.
Duplicate exact TEXT matches fail. Use an index with BINARY collation for
efficient reads (the connector does not create indexes). Identifiers are quoted
and IDs are bound parameters. Identity and resource statements are prepared once
per worker and reused; selected data is read afresh on each fetch.

## Connection identity

By default the application owns identity through `connectionId`; SQLite needs no
account table. Keep the ID stable when moving or restoring the same logical CRM.
Use a new ID when connecting a different logical source. Two connections with
different IDs can both contain `customers.id = '1'` without sharing a Relate
object or cached observations. The file path is a locator, not identity.

This mode explicitly uses `ApplicationSourceConnector`
(`identity: 'application'`), with no `identify()` or `providerAccountId` on its
results or binding. It cannot detect a different database substituted under the
same `connectionId`; the application owns that boundary. Relate policy and
freshness checks still apply. File access is the credential boundary, so use
trusted database files.

### Optional database verification

If the database contains a stable account ID and you want Relate to detect a
replacement under the same connection ID, configure verification explicitly:

```ts
const database = sqlite({
  path: './crm.sqlite',
  identity: { table: 'account', column: 'id' },
});
const binding = connect(customers, {
  connectionId: 'local-crm',
  providerAccountId: 'crm-production',
  connector: database.table('customers', {
    idColumn: 'id',
    columns: ['display_name', 'portfolio', 'stripe_customer_id'],
  }),
});
```

This returns a provider-verified `SourceConnector`. Application-owned and
provider-verified modes have separate retained identities, even with the same
connection ID; switching modes requires explicit adoption in the new scope.

The identity table must contain exactly one row with a nonempty TEXT account ID
without leading or trailing whitespace. Padded IDs are explicitly denied with a
configuration diagnostic; identity is never silently trimmed:

```sql
CREATE TABLE account (id TEXT PRIMARY KEY NOT NULL);
INSERT INTO account VALUES ('crm-production');
```

Provision that identity in the provider database; the connector never creates
it. Keep it stable for the lifetime of that account. A copied database retains
the same identity: provision a new ID if the copy represents a different
account. `identify()` reads the ID, and each fetch reads identity and data in
one SQLite snapshot. Relate compares this evidence to the binding's expected
account. An empty or ambiguous identity is explicit access denial.

A successful lookup with no row returns `deleted`. Missing tables, lock errors,
invalid values, and other database failures throw; they never imply deletion. An
invalid singleton account identity becomes `SourceAccessDenied`. File-open
errors (including missing or unreadable files) and other SQLite errors stay
database failures: a generic CANTOPEN error is not evidence of provider
authorization denial. TEXT, finite numbers and NULL are returned unchanged.
Booleans remain 0/1 and JSON text remains text; describe those representations
in your source schema. Selected BLOBs, nonfinite numbers and integers outside
JavaScript's safe range are rejected. No source version is claimed because
SQLite supplies no per-row version contract.

The system connection can select multiple tables, each using the connection’s
chosen identity mode. Database opening is deferred until the first read or
identify; open errors reject that call. An owned worker serializes reads on one
read-only connection, leaving the application event loop free to enforce source
deadlines. `busyTimeoutMs` defaults to 150 ms (configurable from 0 to 60000); a
writer lock that outlasts that wait still fails. Keep keys indexed and records
small.

An aborted queued read is removed without affecting active work. Aborting an
active read rejects it immediately and retires the worker; later calls get a
fresh connection after teardown. Native SQLite work may finish before worker
termination completes, so teardown and queued reads can take longer than the
caller's deadline. At most one worker is active per system connection. Always
await `database.close()` (or register it with `onDispose`): it rejects
outstanding reads and waits for worker teardown. Closing is idempotent; calls
after close fail.

This package implements record reads, not enumeration, change feeds, provider
writes, or Relate storage.

See [customer accounts](../../examples/customer-accounts) for a runnable
application.
