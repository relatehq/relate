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
  identity: { table: 'account', column: 'id' },
});
const binding = connect(customers, {
  connectionId: 'local-crm',
  providerAccountId: 'crm-production',
  connector: database.table('customers', { idColumn: 'id' }),
});
// In defineApp.setup: onDispose(() => database.close()).
```

`customers` is your `defineSource(...)` definition. Its schema describes the
SQLite columns, and its `idField` must match `idColumn`. The resource needs a
unique TEXT key. Numeric and case-insensitive key aliases are rejected when they
do not match the requested ID exactly. Identifiers are quoted and record IDs are
bound parameters.

The identity table must contain exactly one row with a nonempty TEXT account ID:

```sql
CREATE TABLE account (id TEXT PRIMARY KEY NOT NULL);
INSERT INTO account VALUES ('crm-production');
```

Provision that identity in the provider database; the connector never creates
it. Keep it stable for the lifetime of that account. A copied database retains
the same identity: provision a new ID if the copy represents a different
account. File access is the credential boundary, so use only trusted database
files. `identify()` reads the ID, and each fetch reads identity and data in one
SQLite snapshot. Relate compares this evidence to the binding's expected
account. An empty or ambiguous identity is explicit access denial.

A successful lookup with no row returns `deleted`. Missing tables, lock errors,
invalid values, and other database failures throw; they never imply deletion.
SQLite permission/authorization errors become `SourceAccessDenied`. TEXT, finite
numbers and NULL are returned unchanged. Booleans remain 0/1 and JSON text
remains text; describe those representations in your source schema. BLOBs,
nonfinite numbers and integers outside JavaScript's safe range are rejected. No
source version is claimed because SQLite supplies no per-row version contract.

The system connection can select multiple tables, each implementing
`SourceConnector`. The system owns one read-only connection shared by those
resources; `close()` is idempotent. Calls after close fail. Reads are
synchronous internally, fail immediately on lock contention, and check
cancellation before and after the operation. An AbortSignal cannot interrupt
SQLite work already running on the JavaScript thread. Use indexed keys and small
records. This package implements record reads, not enumeration, change feeds,
provider writes, or Relate storage.

See [customer accounts](../../examples/customer-accounts) for a runnable
application.
