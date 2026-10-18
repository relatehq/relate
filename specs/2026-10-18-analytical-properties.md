# 2026-10-18: Analytical datasets and computed fields

**Status:** design agreed on 2026-10-18 and revised the same day after review;
not implemented. [Decisions](#decisions) lists each decision with its status,
[Open questions](#open-questions) lists what the spike must settle, and
[Revision notes](#revision-notes-2026-10-18) records what this revision changed.

## Outcome

A Relate application often sits next to tables that are not business objects:
events, page views, invoice lines, usage meters. A caller wants "customers with
their October login count", but logins are not customers. Adopting each event as
an object would give millions of rows Relate IDs, policies and evidence they do
not need, and still would not answer the question, because the answer is an
aggregate.

This spec adds **datasets**: typed, policy-governed row collections that are
declared in the graph, bound to an existing table, and associated with objects
by a correlation key. A caller then sends an aggregate **expression** over
`self.<association>` with an object `get` or `query`, and gets a **computed
field** back on each object, with evidence that says how it was produced. In v1
a `query` can also filter and order by a computed field.

Why this shape:

- **Aggregates stay aggregates.** Rows are never adopted and never written to
  the object. The object owns the question; the dataset owns the rows.
- **SQL is the expression language.** Agents already write SQL, and Relate will
  offer one uniform SQL interface: these per-object expressions now, and a
  graph-wide SQL API later
  ([Future](#future-declared-computed-properties-graph-sql-sync-and-other-backends)).
  One dialect, one parser, one set of rules. A structured expression shape may
  be added later, but it would be a second surface, not a replacement.
- **Caller expressions first, declared properties next.** Developer-declared
  computed properties (`loginCount: computed(...)`) are a planned extension that
  reuses every contract below. They are not in v1.
- **Postgres and SQLite first.** Both are already in the stack and need no
  native build. DuckDB, Parquet and warehouses are later backends behind the
  same contract.

## In one example

A caller reads customers with their login count for October. The model declares
no `loginCount` property. The caller asks for the calculation:

```ts
const page = await ana.objects.Customer.query({
  select: ['name'],
  compute: {
    loginsOct: {
      sql: `SELECT COUNT(*) FROM self.events AS e
            WHERE e.eventType = 'login'
              AND e.occurredAt >= $since AND e.occurredAt < $until`,
      parameters: {
        since: '2026-10-01T00:00:00Z',
        until: '2026-11-01T00:00:00Z',
      },
    },
  },
});
// page.data.map((c) => c.data):
// [ { name: 'Acme',    loginsOct: '2' },
//   { name: 'Globex',  loginsOct: '1' },
//   { name: 'Initech', loginsOct: '0' } ]
```

The rows come from an `events` table in an analytics database. Those rows are
not adopted, have no Relate IDs, and are never written to the customer. The
value is computed per customer, per read, over the event rows Ana may use.

The rest of this spec explains each piece: how the developer declares the
dataset and links it to Customer (`self.events`), how it is bound to a table,
who may use it, what types and evidence come back, and what happens when
something fails.

## Running example

All examples use this data. Anything outside it is marked as such.

**Customers** (CRM source `crm.customers`, SQLite file `crm.sqlite`).

| CRM key        | name     | portfolio         | customerSince |
| -------------- | -------- | ----------------- | ------------- |
| `crm_acme`     | Acme     | `portfolio_north` | 2026-09-30    |
| `crm_globex`   | Globex   | `portfolio_north` | 2026-10-01    |
| `crm_initech`  | Initech  | `portfolio_north` | 2026-01-15    |
| `crm_umbrella` | Umbrella | `portfolio_south` | 2026-05-01    |

**Events** (dataset `analytics.events`, table `events` in Postgres database
`analytics`):

| customer_id    | event_type  | occurred_at            | user_id |
| -------------- | ----------- | ---------------------- | ------- |
| `crm_acme`     | `login`     | `2026-09-28T08:00:00Z` | `u_1`   |
| `crm_acme`     | `login`     | `2026-10-02T09:00:00Z` | `u_1`   |
| `crm_acme`     | `login`     | `2026-10-09T10:30:00Z` | `u_2`   |
| `crm_acme`     | `page_view` | `2026-10-09T10:31:00Z` | `u_2`   |
| `crm_globex`   | `login`     | `2026-10-03T14:00:00Z` | `u_7`   |
| `crm_umbrella` | `login`     | `2026-10-04T11:00:00Z` | `u_9`   |

Initech has no events. Umbrella is outside Ana's portfolio.

**Actors.** Both work in `portfolio_north`. Nobody in the example holds the
`support` role.

| Actor | Roles                         | May use `Customer.events` | May read `userId` |
| ----- | ----------------------------- | ------------------------- | ----------------- |
| Ana   | `employee`, `account-manager` | yes                       | no                |
| Fin   | `employee`, `finance`         | no                        | no                |

**Expected values for Ana.**

| Expression                                         | Acme                         | Globex                       | Initech   | Umbrella     |
| -------------------------------------------------- | ---------------------------- | ---------------------------- | --------- | ------------ |
| October logins, `COUNT(*)`                         | `'2'`                        | `'1'`                        | `'0'`     | not returned |
| All-time logins                                    | `'3'`                        | `'1'`                        | `'0'`     | not returned |
| Logins since `self.customerSince`                  | `'2'`                        | `'1'`                        | `'0'`     | not returned |
| Distinct October users, `COUNT(DISTINCT e.userId)` | forbidden                    | forbidden                    | forbidden | not returned |
| Last login, `MAX(e.occurredAt)`                    | `'2026-10-09T10:30:00.000Z'` | `'2026-10-03T14:00:00.000Z'` | `null`    | not returned |

### Terms

| Term               | Meaning                                                             | Running example                                |
| ------------------ | ------------------------------------------------------------------- | ---------------------------------------------- |
| Connector          | Integration code for a database or API                              | the Postgres connector                         |
| Connection         | A configured connector instance; owns access and lifecycle          | `postgres({ connectionId: 'analytics', url })` |
| Resource           | An existing table or view on a connection                           | the `events` table                             |
| Source definition  | Unbound contract for keyed records that back objects                | `crm.customers`                                |
| Dataset definition | Unbound contract for analytical rows; no key, duplicates meaningful | `analytics.events`                             |
| Binding            | Maps a source or dataset definition to a resource                   | `bind(Events, analytics.table('events'))`      |
| Association        | Declared correlation between an object and dataset rows             | `Customer.events`, on the CRM key              |
| Expression         | What a caller sends: `{ sql, parameters }` over one association     | the `loginsOct` SQL above                      |
| Alias              | The caller's name for an expression; the key in `compute`           | `loginsOct`                                    |
| Computed field     | The value and evidence an expression produces on one object         | `loginsOct: '2'` on Acme                       |

This spec uses only these words. "Calculation" and "computation" do not appear
in contracts.

### Statuses used in this spec

These already exist in the protocol
([`packages/protocol/src/index.ts:47`](../packages/protocol/src/index.ts) and
[`:152`](../packages/protocol/src/index.ts)). This table says when each one
appears for computed fields.

| Status                                  | Level   | Appears here when                                                                        |
| --------------------------------------- | ------- | ---------------------------------------------------------------------------------------- |
| `not-found`                             | object  | The object fails its own read policy. No expression is evaluated.                        |
| `ReadError('invalid-request')`          | request | The SQL, an alias, a parameter, a filter or an order entry is rejected before execution. |
| `RequestIssue.problem: 'not-supported'` | request | Valid SQL outside the v1 subset, or a computed filter scope above the host limit.        |
| `forbidden`                             | field   | The actor may use the association but not every referenced column.                       |
| `unavailable`                           | field   | The field could not be produced: correlation key missing, backend failure, bad result.   |
| `completeness: 'partial'`               | read    | At least one field on the object was omitted.                                            |
| `ReadError('incomplete')`               | request | An omitted field was required: `requireComplete: true`, or the alias filters or orders.  |

## What exists today

- Read and query options
  ([`packages/relate/src/operations.ts:32`](../packages/relate/src/operations.ts),
  [`:119`](../packages/relate/src/operations.ts)) select declared properties and
  filter adopted members. No aggregates, and no caller-defined order.
- [`SourceConnector`](../packages/relate/src/connectors.ts) (`:26`) fetches one
  record by key. It has no analytical capability.
- [`connect(...)`](../packages/relate/src/app.ts) (`:19`) returns a per-source
  binding named `Connection`, and setup returns `connections`. This spec renames
  both.
- [`FieldEvidence`](../packages/protocol/src/index.ts) (`:47`) describes native
  or source observations only.
- Persisted observations are scoped by `connectionId`
  ([`packages/postgres/src/index.ts:80`](../packages/postgres/src/index.ts)).
- Object timestamps accept one format
  ([`packages/relate/src/portable-schema.ts:113`](../packages/relate/src/portable-schema.ts)).
- The SQLite connector ([`connectors/sqlite`](../connectors/sqlite/README.md))
  reads keyed records through `node:sqlite`; the Postgres package uses `pg`.
  Neither executes aggregates.

The [README status table](../README.md#status) stays unchanged until this ships.

## Model

### Declaring a dataset

```ts
const Events = defineDataset({
  id: 'analytics.events',
  description: 'One row per recorded customer event.',
  schema: z.object({
    customerId: z.string(),
    eventType: z.string(),
    occurredAt: z.iso.datetime({ offset: true, precision: 3 }),
    userId: z.string().nullable(),
  }),
  // Proposed: stable identities and access, like object properties.
  columns: {
    customerId: { id: 'analytics.events.customer-id', access: ordinary },
    eventType: { id: 'analytics.events.event-type', access: ordinary },
    occurredAt: { id: 'analytics.events.occurred-at', access: ordinary },
    userId: { id: 'analytics.events.user-id', access: identifying },
  },
});
```

- A dataset has typed columns, a description of what one row means, access and a
  binding. It has no key. Duplicate rows are meaningful: `COUNT(*)` counts them.
- **Proposed:** every column has an explicit stable `id`, as object properties
  do. Renaming `userId` keeps its ID. Evidence, policy and errors use IDs
  internally and names at the API.
- A dataset exposes one existing resource. Filters, computed columns and
  aggregations that manufacture a "login events" dataset from `events` are
  views, and views are deferred. Callers filter `eventType = 'login'` in SQL.

### Column types (Proposed)

Every dataset column has a logical type. The physical column must match it on
the bound backend.

| Zod declaration                                  | Logical type   | Postgres           | SQLite (declared affinity, storage)             |
| ------------------------------------------------ | -------------- | ------------------ | ----------------------------------------------- |
| `z.boolean()`                                    | boolean        | `BOOLEAN`          | `INTEGER`, values `0`/`1`                       |
| `z.string()`                                     | string         | `TEXT`, `VARCHAR`  | `TEXT`                                          |
| `z.int32()`                                      | int32          | `INTEGER`          | `INTEGER`                                       |
| `z.int64()`                                      | int64          | `BIGINT`           | `INTEGER`                                       |
| `z.number()`                                     | float64        | `DOUBLE PRECISION` | `REAL`                                          |
| `decimal(18, 2)` (Relate helper; name open)      | decimal(18, 2) | `NUMERIC(18,2)`    | not supported in v1; store minor units as int64 |
| `z.iso.datetime({ offset: true, precision: 3 })` | timestamp (ms) | `TIMESTAMPTZ`      | `TEXT`, canonical `YYYY-MM-DDTHH:MM:SS.sssZ`    |
| `z.iso.datetime({ offset: true, precision: 6 })` | timestamp (µs) | `TIMESTAMPTZ`      | `TEXT`, canonical form with six fraction digits |
| `.nullable()` on any of the above                | nullable       | nullable column    | column without `NOT NULL`                       |

- Object properties keep today's single timestamp format. Datasets also accept
  microsecond precision because analytical stores commonly use it.
- A Postgres `TIMESTAMP` without a time zone is rejected; Relate does not guess
  a zone.
- SQLite has no timestamp type. A timestamp column is `TEXT` in the canonical
  UTC form, and comparisons are textual. The bind-time check validates the
  declared affinity and nullability from `PRAGMA table_info`; values are
  trusted, as on every backend. A value that is not in canonical form is an
  `invalid-result` failure when it reaches a result, and is otherwise compared
  as text.

### Associating a dataset with an object

```ts
const Customer = defineObject({
  id: 'business.customer',
  membership: source(customerRecords),
  properties: {
    id: objectId({ id: 'business.customer.key', access: ordinary }),
    externalId: from(customerRecords.fields.id, {
      id: 'business.customer.external-id',
      access: ordinary,
    }),
    name: from(customerRecords.fields.name, {
      id: 'business.customer.name',
      access: ordinary,
    }),
    customerSince: from(customerRecords.fields.customerSince, {
      id: 'business.customer.customer-since',
      access: ordinary,
    }),
  },
  datasets: {
    events: {
      id: 'business.customer.events',
      dataset: Events,
      on: { customerId: 'externalId' }, // Events.customerId = Customer.externalId
    },
  },
});

const graph = defineGraph({
  id: 'customer-workspace',
  objects: { Customer },
  datasets: { Events },
  // ...
});
```

- `on` maps dataset columns (keys) to properties of the containing object
  (values). Both sides are checked at compile time and resolved to stable IDs.
- The Relate object ID is not the CRM key, so the mapping goes through
  `externalId`. **Proposed:** `on` may also target the `objectId` property, for
  datasets that record Relate IDs, such as events about Relate-owned objects.
- Composite keys use several entries. Outside the running example:
  `on: { tenantId: 'tenantId', customerId: 'externalId' }`.
- **Proposed:** both sides must have the same logical type (table below).
  `string = int64` is a compile error; there is no implicit cast.
- **Proposed:** the target property need not be unique. Two customers sharing an
  `externalId` both receive the value computed for that key.
- The association is a model fact, so it appears in discovery. Correlating
  objects to rows only inside caller SQL is not an accepted alternative.

### Logical types of object properties (Proposed)

`on` and `self.<property>` compare object properties with dataset columns, so
object property schemas need logical types too.

| Object property schema                           | Logical type   | Notes                                                                  |
| ------------------------------------------------ | -------------- | ---------------------------------------------------------------------- |
| `z.boolean()`                                    | boolean        |                                                                        |
| `z.string()`, `objectId(...)`                    | string         | Object IDs compare as strings                                          |
| `z.int32()`                                      | int32          |                                                                        |
| `z.int64()`                                      | int64          |                                                                        |
| `z.number()`                                     | float64        | Not usable in `on`; equality on floats is a compile error              |
| `z.iso.datetime({ offset: true, precision: 3 })` | timestamp (ms) | Comparable with µs columns; the ms side is exact                       |
| `LocalDateTimeSchema`                            | none           | No instant semantics; a compile error in `on` and in `self.<property>` |
| Reference properties                             | none           | Compile error; correlate on a scalar instead                           |
| `.nullable()` / `.optional()`                    | nullable       | A null or absent value makes the field `unavailable`                   |

## Binding and schema checks

In application setup:

```ts
const crm = sqlite({ connectionId: 'crm', path: './crm.sqlite' });
const analytics = postgres({
  connectionId: 'analytics',
  url: process.env.ANALYTICS_DATABASE_URL,
});
context.onDispose(() => crm.close());
context.onDispose(() => analytics.close());

return {
  bindings: [
    bind(customerRecords, crm.table('customers')),
    bind(Events, analytics.table('events'), {
      columns: {
        customerId: 'customer_id',
        eventType: 'event_type',
        occurredAt: 'occurred_at',
        userId: 'user_id',
      },
    }),
  ],
};
```

A dataset may also be bound to a SQLite table, for example
`bind(Events, crm.table('events'))` in a single-file example.

- `columns` is needed only where physical names differ from declared names.
  Physical identifiers are always quoted in generated SQL.
- One connection serves many bindings. A connector implements each capability
  explicitly: keyed reads for sources, analytical execution for datasets.
  Binding `customerRecords` to a connector without keyed reads fails at startup,
  as does binding `Events` to one without analytical execution.
- Hosts, URLs, tables and credentials are host configuration. Caller SQL can
  only name declared datasets through `self.<association>`.
- Persisted observations are scoped by `connectionId` today. Once one connection
  serves several bindings, the scope key becomes connection plus resource, so
  that two tables on one connection never share observations. This is a Postgres
  migration in `packages/postgres`. In development mode existing observation
  rows are dropped by that migration; a rewrite is not needed before the first
  release.

**Proposed bind-time check.** When the runtime starts, the connector reports the
physical schema. Relate compares it with the declaration and refuses the binding
on a mismatch:

```text
Binding analytics.events → analytics:events is invalid:
  occurredAt: declared timestamp (ms, with offset), found TIMESTAMP
    (no time zone). Store TIMESTAMPTZ or convert in the source table.
  customerId: declared non-nullable, found nullable VARCHAR.
    Declare z.string().nullable() or add NOT NULL.
```

Rows are not validated individually; at analytical scale that is a scan.
Declared types are trusted once the physical schema matches. The check runs
again on every `relate dev` reload. A schema change under a running production
binding is detected only when a statement fails or returns a mismatched type,
which is an `execution-failed` or `invalid-result` failure.

## Authorization

Reading a customer does not authorize reading its events. A computed field needs
three checks: the customer is visible, the association may be used, and every
referenced column is readable. That includes columns used only in `WHERE`.

**Policy shape (agreed in this revision).** Association policy and dataset
policy are separate:

```ts
policies: {
  Customer: {
    read: {
      gate: access.role('employee'),
      where: { portfolio: { eq: access.claims.portfolio } },
      evidenceMaxAgeMs: 30000,
    },
    // Who may use self.events.
    datasets: {
      events: { gate: access.role('account-manager') },
    },
  },
  // Column groups for the dataset, wherever it is used.
  Events: {
    groups: { identifying: access.role('support') },
    // Row policy for uncorrelated use (future graph SQL) only:
    // read: { gate, where: { region: { eq: access.claims.region } } },
  },
},
```

Why two policies: `self.events` has already passed Customer's row policy, so
"Acme's events" are scoped by Acme's visibility. A future
`SELECT COUNT(*) FROM datasets.Events` has no customer to inherit from, and
Events has no `portfolio` column. It needs its own row policy over dataset
columns. Keeping them separate means v1 needs no cross-source row policy, and
using one never implies the other.

**Missing policy is a compile error**, as it is for objects today
([`packages/relate/src/compiler.ts:457`](../packages/relate/src/compiler.ts),
`policy.missing`). Every association needs a `datasets.<name>` entry under its
object, and every dataset with a column outside `ordinary` needs a `groups`
entry. Silent denial is not an option: a developer who forgets a policy learns
it at compile time, not from an agent reporting an unknown name.

**Disclosure.** Gates hide; groups refuse. This mirrors objects, where a failed
gate is `not-found` and a restricted field group is `forbidden`.

- An association the actor may not use is absent from their discovery, and a
  reference to it is `invalid-request` with `problem: 'unknown-property'`,
  exactly like an unknown name. Fin cannot learn that events exist.
- A column the actor may not read is listed in discovery with `readable: false`,
  and an expression that references it is `forbidden`, like selecting a
  restricted property. Ana learns that `userId` exists and that a role she lacks
  is required; she never learns a value.

What each actor gets for `loginsOct` on Acme:

| Actor | Request                    | Result                                                                                  |
| ----- | -------------------------- | --------------------------------------------------------------------------------------- |
| Ana   | `loginsOct`                | `loginsOct: '2'`                                                                        |
| Fin   | `loginsOct`                | `invalid-request`: `self.events` is not in Fin's discovery, so it is an unknown name    |
| Ana   | `COUNT(DISTINCT e.userId)` | field omitted; evidence `{ status: 'forbidden' }`, because `userId` is in `identifying` |
| Ana   | Umbrella's ID with `get`   | `{ status: 'not-found' }`; no statement runs                                            |

- Caller SQL cannot weaken scope. Relate ANDs the correlation and policy
  predicates outside the caller's `WHERE`, so `OR 1 = 1` widens nothing.
- A correlation property that is forbidden, unavailable, stale-omitted, null or
  absent makes the field `unavailable` with `reason: 'correlation-unavailable'`.
  It never widens the scan and never yields `0`.
- `self.<property>` other than the correlation key follows the same rule: a
  property the actor may not read makes the field `forbidden`; one that is
  unavailable or null makes it `unavailable`.
- Tenancy is not assumed. One database may hold events for many customers. A
  tenant rule, where one exists, is ordinary dataset or association policy.

## Request

### The `compute` option

```ts
interface AnalyticalExpression {
  readonly sql: string;
  readonly parameters?: Readonly<Record<string, Json>>;
}

interface AnalyticalReadOptions {
  readonly compute?: Readonly<Record<string, AnalyticalExpression>>;
}

interface AnalyticalQueryOptions extends AnalyticalReadOptions {
  /** Property filters as today, plus computed aliases. */
  readonly where?: Record<string, PropertyFilter | ComputedFilter>;
  /** Computed aliases only in v1. */
  readonly orderBy?: readonly { field: string; direction: 'asc' | 'desc' }[];
}
```

`compute` is added to object `get` and `query` options only, not to traversal,
source fetch or action input. Traversal is excluded because its page is a
relationship's members, not an object scope; computing over traversed objects is
deferred with graph SQL. The same JSON travels across the embedded, HTTP
(request body) and MCP (tool input) paths, and every execution boundary
validates it.

```ts
const lastLogin = {
  sql: `SELECT MAX(e.occurredAt) FROM self.events AS e
        WHERE e.eventType = 'login'`,
};

const acme = await ana.objects.Customer.get(acmeId, {
  select: ['name'],
  compute: { lastLogin },
});
// acme.data: { name: 'Acme', lastLogin: '2026-10-09T10:30:00.000Z' }

const initech = await ana.objects.Customer.get(initechId, {
  select: ['name'],
  compute: { lastLogin },
});
// initech.data: { name: 'Initech', lastLogin: null }   // no logins; valid SQL null
```

- An alias may not equal any declared property name, selected or not, and must
  be safe as an object key (`__proto__` is rejected).
- Two aliases with the same expression are evaluated independently. Aliases are
  not stable IDs and cannot reference each other.
- `compute` adds result fields; it does not change what `select` means. Calls
  without `compute` behave exactly as today.

### `self`

- `self.events` means "rows of the `events` association for this object". It
  applies `Events.customerId = self.externalId`.
- `self.<property>` reads a property of the current object, under ordinary
  authorization and freshness. It need not be selected and is not returned:

  ```sql
  SELECT COUNT(*) FROM self.events AS e
  WHERE e.eventType = 'login' AND e.occurredAt >= self.customerSince
  ```

  For Ana this gives Acme `'2'` (the 28 September login is before 30 September),
  Globex `'1'`, Initech `'0'`.

- `self` is reserved. It is not a table or a parameter, and aliases cannot
  shadow it.

### Parameters and literals

- Parameters are values only. A parameter cannot stand in for a table, column,
  SQL fragment or `self`.
- Types come from context: `$since` compared with `occurredAt` is a timestamp,
  so `'2026-10-01T00:00:00Z'` is parsed as an instant. An ambiguous parameter,
  such as `SELECT $x`, is rejected unless explicitly `CAST`. One parameter used
  in two places with different inferred types is `invalid-request`.
- Input encoding mirrors the output encoding. A value that does not match is
  `invalid-request` with `problem: 'invalid-value'`:

  | Logical type  | Parameter JSON                                        | Literal in SQL                                                                             |
  | ------------- | ----------------------------------------------------- | ------------------------------------------------------------------------------------------ |
  | boolean       | `true`                                                | `TRUE`, `FALSE`                                                                            |
  | int32         | number, integral                                      | `42`                                                                                       |
  | int64         | decimal string, or number when safe                   | `42`                                                                                       |
  | decimal(p, s) | decimal string                                        | `1234.50`                                                                                  |
  | float64       | number                                                | `12.5`                                                                                     |
  | string        | string                                                | `'login'`                                                                                  |
  | timestamp     | ISO instant with offset                               | `'2026-10-01T00:00:00Z'` compared with a timestamp column; a date-only literal is rejected |
  | null          | `null` (only in `IS [NOT] NULL` contexts via literal) | `NULL`                                                                                     |

  A string literal takes the type of the column it is compared with. A literal
  that cannot be read as that type is `invalid-request`.

### SQL subset

Relate's SQL dialect is Postgres grammar. The v1 subset:

- One `SELECT` with one output column, `FROM self.<association>` with an
  optional alias.
- `COUNT(*)`, `COUNT(x)`, `COUNT(DISTINCT x)`, `SUM`, `AVG`, `MIN`, `MAX`.
- In `WHERE`: typed comparisons, `AND`, `OR`, `NOT`, `IS [NOT] NULL`.
- Column references, `self.<property>`, literals, `$named` parameters,
  `COALESCE(<aggregate>, <literal>)`, and the casts listed in the
  [conformance corpus](#conformance-corpus).

Rejected: joins, CTEs, subqueries, `GROUP BY`, windows, `UNION`, `ORDER BY`,
`LIMIT`, table functions, UDFs and anything other than a query. An unknown node
fails closed.

```sql
-- Accepted
SELECT COUNT(DISTINCT e.userId) FROM self.events AS e
WHERE e.eventType = 'login' AND e.occurredAt >= $since

-- Rejected: not-supported (must return one value per customer)
SELECT e.eventType, COUNT(*) FROM self.events AS e GROUP BY e.eventType

-- Rejected: not-supported (table function; also impossible after generation)
SELECT COUNT(*) FROM pg_read_file('/etc/passwd')
```

Empty input still returns one row: `COUNT` is `'0'`; `SUM`, `AVG`, `MIN` and
`MAX` are `null`. `COUNT(*)` counts duplicate rows, `COUNT(x)` skips nulls and
`COUNT(DISTINCT x)` counts distinct non-null values.

Identifier rules (case sensitivity, quoting, reserved words) and the exact cast
set are fixed by the conformance corpus during the spike.

### Filtering and ordering by computed fields

A `query` may use a computed alias in `where` and in `orderBy`:

```ts
// Customers with no October logins, most recently active first.
const page = await ana.objects.Customer.query({
  select: ['name'],
  compute: { loginsOct, lastLogin },
  where: { loginsOct: { eq: '0' } },
  orderBy: [{ field: 'lastLogin', direction: 'desc' }],
  limit: 20,
});
// page.data: [ { name: 'Initech', loginsOct: '0', lastLogin: null } ]
```

- `where` on an alias accepts the same operators as a property of the same
  logical type: scalar equality, `eq`, `in`, and `gt`, `gte`, `lt`, `lte` for
  numbers, decimals and timestamps. Values use the parameter encoding above, so
  an int64 bound is a string. A mismatched value is `invalid-request`.
- `null` never satisfies a comparison. To select "no last login", write the
  expression with `COALESCE` and compare with the fallback. `COUNT` is never
  null, so `eq: '0'` is the natural "none" test.
- `orderBy` is new. In v1 its entries name computed aliases only; ordering by
  declared properties stays deferred, and today's rule that query results have
  no caller-defined order still holds for queries without `orderBy`. Nulls sort
  last in both directions. Ties break on object ID ascending, so the order is
  total and the continuation cursor can encode `(value, id)`.
- An alias used in `where` or `orderBy` is **required**: if its evaluation fails
  for any object in scope, the query fails with `ReadError('incomplete')` naming
  the alias and reason, whatever `requireComplete` says. A filtered or ordered
  result built on missing values would be wrong, not partial.
- The alias must still be declared in `compute`. It is returned like any other
  computed field.
- Property filters and policy still decide the candidate set; computed filters
  narrow it. See [How a query executes](#how-a-query-executes) for the scope
  limit this implies.

### Collection semantics

| Operation                                                | Ana's result                            |
| -------------------------------------------------------- | --------------------------------------- |
| `Customer.get(acmeId)` with `loginsOct`                  | Acme, `loginsOct: '2'`                  |
| `Customer.query()` with `loginsOct`                      | Acme `'2'`, Globex `'1'`, Initech `'0'` |
| `Customer.query({ where: { loginsOct: { gte: '1' } } })` | Acme `'2'`, Globex `'1'`                |
| Total October logins across Ana's customers              | `'3'`: future graph SQL, not `compute`  |

- `self` is always one object, never the matching collection.
- Without computed filters or order, paging selects customers first and each
  value covers that customer's full authorized event scope, not a page of
  events. `compute` never changes membership.
- Different pages and different connections are not one snapshot. A value can
  change between two pages of one query; the cursor positions on `(value, id)`
  as last observed.

## Response

### Result type of each expression (Proposed)

Relate decides the result type from the declared input types. The backend's
native result type is checked against it, never passed through. This keeps the
JSON encoding identical across backends: Postgres's `SUM(INTEGER)` is `int8` and
SQLite's is a 64-bit integer, and both return a Relate int64.

| Expression                                  | Input type               | Result type        | Notes                                        |
| ------------------------------------------- | ------------------------ | ------------------ | -------------------------------------------- |
| `COUNT(*)`, `COUNT(x)`, `COUNT(DISTINCT x)` | any                      | int64              | never null                                   |
| `SUM(x)`                                    | int32, int64             | int64              | overflow is an execution failure             |
| `SUM(x)`                                    | decimal(p, s)            | decimal(38, s)     | overflow is an execution failure             |
| `SUM(x)`                                    | float64                  | float64            |                                              |
| `AVG(x)`                                    | int32, int64, float64    | float64            | use `SUM`/`COUNT` for exact averages         |
| `AVG(x)`                                    | decimal(p, s)            | decimal(38, s + 4) | half-even rounding; to be confirmed in spike |
| `MIN(x)`, `MAX(x)`                          | T                        | T                  |                                              |
| `COALESCE(agg, literal)`                    | T, literal castable to T | T, non-null        |                                              |

`MAX(x)` on an int32 column is a JSON number while `SUM(x)` on the same column
is a string. That follows from the result type, not the column; `meta.computed`
says which.

### JSON encoding (agreed)

| Logical type  | JSON                                     | Example                                |
| ------------- | ---------------------------------------- | -------------------------------------- |
| boolean       | boolean                                  | `true`                                 |
| int32         | number                                   | `42`                                   |
| int64         | decimal string                           | `"42"`, `"9007199254740993"`           |
| decimal(p, s) | decimal string, exactly `s` places       | `"1234.50"`                            |
| float64       | number                                   | `12.5`; NaN and ±Infinity are failures |
| string        | string                                   | `"Acme"`                               |
| timestamp     | UTC ISO string at the declared precision | `"2026-10-09T10:30:00.000Z"`           |
| SQL null      | `null`                                   | `null`                                 |

Values never change representation with magnitude. `COUNT` is a string even when
it is `"0"`. Postgres already returns `int8` as a string in `pg`; SQLite results
are read with `readBigInts` so that large values are never rounded.

### Types in every response (Proposed)

Compact evidence omits routine fields, but a caller cannot decode `"2"` without
knowing it is an int64. Types therefore get their own slot, present in both
evidence modes:

```ts
{
  status: 'ok',
  id: acmeId,
  data: { name: 'Acme', loginsOct: '2', lastLogin: '2026-10-09T10:30:00.000Z' },
  meta: {
    evidence: 'compact',
    completeness: 'complete',
    degraded: false,
    definitionRevision: 'sha256:…',
    computed: {
      loginsOct: { type: 'int64', nullable: false },
      lastLogin: { type: 'timestamp', precision: 3, nullable: true },
    },
  },
}
```

The type comes from the expression, not the data, so it is the same on every row
of a query page.

### Decoding computed values (agreed in this revision)

TypeScript typing of `data` for computed aliases is the JSON scalar union. A
decoder ships in v1 with `relate/consumer`, so no caller has to parse `"2"` by
hand:

```ts
import { decodeComputed } from 'relate/consumer';

const acme = await ana.objects.Customer.get(acmeId, { compute: { loginsOct } });
const fields = decodeComputed(acme); // uses acme.meta.computed
fields.loginsOct; // bigint 2n
fields.lastLogin; // Date | null

// Explicit, range-checked narrowing when a number is wanted.
const n = fields.loginsOct.toNumber(); // throws above Number.MAX_SAFE_INTEGER
```

Int64 decodes to `bigint`, decimal to a string by default or a caller-supplied
decimal constructor, timestamps to `Date`. The exact helper name and whether it
returns wrapped or plain values is [open question 6](#open-questions).

### Evidence

**Proposed.** `FieldEvidence` gains a computed variant. It does not pretend to
be a source observation. The existing variants are elided below; see
[`packages/protocol/src/index.ts:47`](../packages/protocol/src/index.ts) for
their full shape.

```ts
type FieldEvidence =
  | { status: 'forbidden' }
  | {
      status: 'unavailable';
      reason?: ComputedUnavailableReason;
      retryable?: boolean;
    }
  | {
      status: 'available' | 'absent';
      source: 'native' | 'source'; /* …as today */
    }
  | {
      status: 'available';
      source: 'computed';
      freshness: 'unverified'; // input assumed current; see below
      computedAt: string;
      inputs: {
        associationId: string; // 'business.customer.events'
        datasetId: string; // 'analytics.events'
        bindingRevision: string; // changes when the binding changes
        readAt: string; // when the statement that read the rows started
        modifiedAt?: string; // when the backend can report input modification
      }[];
      coverage: 'complete'; // every row in the authorized scope was evaluated
      dependencies: Record<string, FieldEvidence>; // e.g. externalId
    };

type ComputedUnavailableReason =
  'correlation-unavailable' | 'execution-failed' | 'invalid-result' | 'busy';
```

Ana's full-evidence read of `loginsOct` on Acme:

```json
{
  "status": "available",
  "source": "computed",
  "freshness": "unverified",
  "computedAt": "2026-10-18T09:41:07.212Z",
  "inputs": [
    {
      "associationId": "business.customer.events",
      "datasetId": "analytics.events",
      "bindingRevision": "sha256:…",
      "readAt": "2026-10-18T09:41:07.180Z"
    }
  ],
  "coverage": "complete",
  "dependencies": {
    "externalId": {
      "status": "available",
      "source": "source",
      "freshness": "fresh",
      "observedAt": "2026-10-18T09:40:51.003Z"
    }
  }
}
```

- `freshness: 'unverified'` exists because v1 assumes analytical inputs are
  current and checks nothing about the ingestion pipeline. Reporting `'fresh'`
  would be the exact false claim evidence exists to prevent. Evidence still says
  what is known: `readAt` is when the rows were read, and `modifiedAt` is
  present when the backend can report when the input last changed (a SQLite
  file's modification time; absent for Postgres, which does not track table
  modification without triggers). Synchronization will introduce verified
  freshness
  ([Future](#future-declared-computed-properties-graph-sql-sync-and-other-backends)).
- `coverage: 'complete'` means every row in the authorized scope was read. It
  does not mean the table holds every real-world login.
- `evidenceMaxAgeMs`, `maxAgeMs`, `refresh` and `stale` apply to `dependencies`
  only. A policy author who sets `evidenceMaxAgeMs: 30000` on Customer gets that
  bound on `externalId`, not on the event count. The access-control docs and the
  policy compiler's error messages must say so, and discovery states it under
  `compute.freshness`.
- Raw SQL, parameter values, hosts and credentials never appear in evidence or
  activity. A public expression identity, if added, must not hash guessable
  parameters.
- No results are cached across requests in v1. Within one request, identical
  expression, parameters, correlation key, actor scope and binding may be
  evaluated once.

## Failures and errors

Failure granularity is **per page and per alias**, not per object: one statement
serves every object on a page, so when it fails, the alias is omitted on every
object of that page and each read is `partial`. The exceptions are
`correlation-unavailable` and `forbidden` on a `self.<property>`, which are
decided per object before the statement runs.

| Situation                                                                                                 | Outcome                                                                                                 |
| --------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| Bad SQL, unsupported construct, alias collision, missing or mistyped parameter, bad filter or order entry | Request rejected with `invalid-request` before any execution                                            |
| Column not readable by the actor                                                                          | Field omitted, `forbidden`; read is `partial`                                                           |
| Correlation property or `self.<property>` unavailable or null                                             | Field omitted, `unavailable` (`reason: 'correlation-unavailable'`)                                      |
| Backend unreachable, statement fails, or statement exceeds its time budget                                | Field omitted on the page, `unavailable` (`reason: 'execution-failed'`, `retryable: true`)              |
| Analytical queue full or wait exceeded                                                                    | Field omitted on the page, `unavailable` (`reason: 'busy'`, `retryable: true`)                          |
| Overflow, NaN, unsupported temporal value, non-canonical SQLite timestamp                                 | Field omitted on the page, `unavailable` (`reason: 'invalid-result'`)                                   |
| Any of the above with `requireComplete: true`                                                             | `ReadError('incomplete')` naming the alias and reason                                                   |
| Any of the above on an alias used in `where` or `orderBy`                                                 | `ReadError('incomplete')`, regardless of `requireComplete`                                              |
| Computed filter or order over more objects than the host scope limit                                      | `ReadError('invalid-request')`, `problem: 'not-supported'`, message asks for a narrower property filter |
| Caller `timeoutMs` expires on the whole read                                                              | The read's own timeout error, as today; never a partial count                                           |
| Valid empty input                                                                                         | `'0'` for `COUNT`, `null` for the others; not a failure                                                 |

Two clocks, two outcomes: the analytical statement's host time budget makes the
field `unavailable` and lets the rest of the read succeed; the caller's
`timeoutMs` on the read fails the read. The statement is cancelled in both
cases.

Errors extend today's `RequestIssue`
([`packages/protocol/src/index.ts:152`](../packages/protocol/src/index.ts)) with
SQL location and a suggestion:

```ts
{
  code: 'invalid-request',
  operation: 'Customer.get',
  issues: [{
    path: ['compute', 'loginsOct', 'sql'],
    problem: 'unknown-property',
    message: 'Unknown column occuredAt on self.events. Did you mean occurredAt?',
    location: { line: 2, column: 15 }, // 1-based line, 1-based UTF-16 column; to be fixed in protocol review
    accepted: ['customerId', 'eventType', 'occurredAt', 'userId'],
    suggestion: 'occurredAt',
  }],
}
```

Suggestions come only from the actor's discovery. Execution failures are never
reported as bad SQL, so an agent does not keep rewriting a correct query during
an outage.

## Execution

### Pipeline

```text
SQL + parameters
  → parser (libpg_query, WASM)        pure parse, no database, in process
  → Relate SQL representation         (no parser nodes escape)
  → resolve names, types, policy      → authorized dataset query
  → backend SQL generation            (never the caller's original string)
  → execute, validate result types    → values + evidence
```

```ts
interface SqlParser {
  parse(sql: string): RelateSqlQuery;
}

interface AnalyticalBackend {
  describe(resource: ResourceRef): Promise<PhysicalSchema>;
  plan(request: AuthorizedDatasetQuery): Promise<DatasetPlanResult>;
  execute(
    plan: PreparedDatasetPlan,
    options: { signal: AbortSignal; timeoutMs: number },
  ): Promise<DatasetQueryResult>;
  /** Optional: when the input last changed, if the backend can know. */
  modifiedAt?(resource: ResourceRef): Promise<string | undefined>;
}
```

- Only the runtime constructs `AuthorizedDatasetQuery`; it is never accepted
  from a wire.
- **Parser (Proposed).** libpg_query compiled to WASM parses Postgres grammar,
  which is Relate's dialect, without a native addon or a database connection.
  Its version is pinned and the conformance corpus gates upgrades. If the spike
  finds its load time or size unacceptable, the fallback is a Relate-owned
  parser for the v1 subset; the corpus is the same either way.
- The parser and backend adapters are separate contracts. Swapping either means
  passing the same conformance corpus.

### How a query executes

**One statement per page, per association, per connection.** For Ana's query
page, Relate first reads the three customers and their `externalId`s, then
generates one statement for every alias on `self.events`, using filtered
aggregates so that different `WHERE` clauses share one scan:

```sql
WITH keys(slot, k0, p_customer_since) AS (
  VALUES (0, 'crm_acme', $3), (1, 'crm_globex', $4), (2, 'crm_initech', $5)
  -- objects whose correlation key is null or unavailable are not in keys;
  -- their slots are marked unavailable before the statement runs
),
agg AS (
  SELECT e.customer_id AS k0,
         COUNT(*) FILTER (WHERE e.event_type = 'login'
                            AND e.occurred_at >= $1 AND e.occurred_at < $2) AS v_loginsOct,
         MAX(e.occurred_at) FILTER (WHERE e.event_type = 'login')             AS v_lastLogin
  FROM "events" AS e
  WHERE e.customer_id IN (SELECT k0 FROM keys)              -- correlation, outside
  GROUP BY e.customer_id
)
SELECT keys.slot,
       COALESCE(agg.v_loginsOct, 0) AS v_loginsOct,          -- COUNT: empty group is 0
       agg.v_lastLogin                                       -- others: empty group is NULL
FROM keys LEFT JOIN agg USING (k0)
ORDER BY keys.slot;
-- slot 0 → 2, 2026-10-09T10:30:00Z;  slot 1 → 1, 2026-10-03T14:00:00Z;  slot 2 → 0, NULL
```

- `self.<property>` references become extra columns in `keys`, carried as
  parameters, never interpolated. Every customer on the page gets exactly one
  value, including Initech with no events.
- Aliases on different associations, or associations bound on different
  connections, run as separate statements. The acceptance criterion is one
  statement per association per page.
- SQLite has `FILTER` since 3.30 and `node:sqlite` ships a newer version. Both
  backends run this shape.

**With a computed filter or order**, paging can no longer select customers
first. Relate then:

1. Resolves the full candidate set: every object that passes policy and the
   property filters, up to the host's computed scope limit (default 10,000).
   Beyond it the query is rejected with `not-supported` and a message asking for
   a narrower property filter.
2. Runs the statement above over the candidate keys in batches of the host's
   keys-per-statement limit (default 1,000).
3. Applies the computed `where`, sorts by `(value, id)` and returns the
   requested page. The continuation cursor encodes the last `(value, id)`; the
   next page repeats steps 1 to 3 and resumes after that position.

Filtering and ordering in the runtime rather than in SQL keeps the backend
contract to one aggregate shape and makes the limit explicit. A backend may
later push the filter down; the observable results must not change.

### Host limits and concurrency

Defaults are host configuration. A caller timeout can tighten these, never raise
them.

| Limit                                       | Default          | When exceeded                                         |
| ------------------------------------------- | ---------------- | ----------------------------------------------------- |
| SQL length per expression                   | 4 KiB            | `invalid-request`                                     |
| Parsed nodes per expression                 | 256              | `invalid-request`                                     |
| Parameters per expression; size per value   | 16; 1 KiB        | `invalid-request`                                     |
| Expressions per request                     | 8                | `invalid-request`                                     |
| Keys per statement                          | 1,000            | batched internally                                    |
| Objects in a computed filter or order scope | 10,000           | `invalid-request`, `not-supported`                    |
| Time per statement                          | 5 s              | `unavailable`, `execution-failed`, `retryable`        |
| Concurrent statements per connection        | 4                | queued                                                |
| Queue depth; maximum wait                   | 32; 2 s          | `unavailable`, `busy`, `retryable`                    |
| Memory per statement                        | backend-specific | Postgres: optional `SET LOCAL work_mem`; SQLite: none |

- Cancellation: Postgres uses the connection's cancel request; SQLite uses the
  progress handler to interrupt. If a statement does not stop within a bound,
  the connection is closed and reopened; a SQLite statement runs on a worker
  that is terminated.
- `relate dev` reloads rebind every dataset, re-run the schema check and close
  the old connections after in-flight statements finish or are cancelled. A
  request that straddles a reload gets `runtime-retired`, as today.
- Postgres statements run as `READ ONLY` transactions with `statement_timeout`
  set per statement; SQLite connections for datasets open the file read-only.
  Caller SQL cannot reach `SET`, `ATTACH`, table functions or multiple
  statements because it is never executed; only generated SQL is.

### Backends in v1

| Backend  | Package                                  | Notes                                                                                                                       |
| -------- | ---------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| Postgres | `connectors/postgres` (new, over `pg`)   | Separate from `packages/postgres`, which persists Relate's own observations. Analytical tables live in the user's database. |
| SQLite   | `connectors/sqlite` gains the capability | `node:sqlite`, read-only handle per dataset connection, `readBigInts` on. Enough for examples and single-file apps.         |

The example that ships with this feature keeps `events` in the same SQLite file
as the CRM tables, so a reader needs nothing beyond Node.

## Discovery, activity and Inspector

**Discovery.** Agents must learn the association, its columns and the SQL rules
before writing SQL. Proposed shape for Ana:

```json
{
  "object": "Customer",
  "datasets": {
    "events": {
      "description": "One row per recorded customer event.",
      "columns": {
        "customerId": { "type": "string" },
        "eventType": { "type": "string" },
        "occurredAt": { "type": "timestamp", "precision": 3 },
        "userId": { "type": "string", "nullable": true, "readable": false }
      },
      "correlation": "customerId = self.externalId"
    }
  },
  "compute": {
    "syntax": "SELECT <aggregate> FROM self.<dataset> [AS e] [WHERE …]",
    "aggregates": ["COUNT", "COUNT DISTINCT", "SUM", "AVG", "MIN", "MAX"],
    "encoding": "int64 and decimal results are JSON strings",
    "filters": "where and orderBy accept computed aliases; null never matches",
    "freshness": "inputs are read live and not verified against the source system",
    "example": "SELECT COUNT(*) FROM self.events AS e WHERE e.eventType = 'login'"
  }
}
```

Fin's discovery has no `datasets.events`. Discovery is served by the existing
describe methods; MCP includes it in the tool descriptions it already builds
from discovery and does not re-read it per call.

**Activity** ([2026-10-13 spec](./2026-10-13-activity.md)). A read with
`compute` records the association and dataset IDs used, the number of
expressions, whether computed filters or order were used, and the failure reason
of each failed alias. It records no SQL, parameters or aliases.

**Inspector.** Shows datasets as nodes with association edges to objects, and
columns with their access groups. Exact presentation is left to the Inspector.

## Conformance corpus

The corpus is the executable definition of the SQL subset. It lives in
`packages/relate/test/sql-corpus/` as one JSON file per case:

```json
{
  "name": "count-filtered-by-timestamp-parameter",
  "sql": "SELECT COUNT(*) FROM self.events AS e WHERE e.occurredAt >= $since",
  "parameters": { "since": "2026-10-01T00:00:00Z" },
  "expect": {
    "representation": { "...": "canonical Relate SQL representation" },
    "resultType": { "type": "int64", "nullable": false }
  }
}
```

A rejected case has
`"expect": { "issue": { "problem": "not-supported", "path": [...] } }` instead.
Three suites consume the corpus:

- the parser suite (any `SqlParser` must produce the expected representation or
  issue);
- the generation suite per backend (the generated SQL for each accepted case
  runs against a seeded copy of the running example and yields the expected
  values);
- the identifier and cast suites, which fix case sensitivity, quoting, reserved
  words and the accepted cast set.

`packages/relate` owns the corpus and the parser suite; each backend owns its
generation suite. A parser or backend upgrade is a corpus run.

## Future: declared computed properties, graph SQL, sync and other backends

Not in v1; recorded so the v1 boundaries leave room for them.

**Declared computed properties** reuse the dataset, association, policy, type
and evidence contracts. The developer names the expression once, gives it a
stable ID and access group, and callers select it like any property, without
writing SQL:

```ts
properties: {
  loginCount: computed({
    id: 'business.customer.login-count',
    access: ordinary,
    sql: `SELECT COUNT(*) FROM self.events AS e WHERE e.eventType = 'login'`,
  }),
}
// await ana.objects.Customer.get(acmeId, { select: ['name', 'loginCount'] })
```

Declared properties appear in discovery with their type, can carry their own
policy, and may later be filtered and ordered like other properties. Nothing in
v1 may prevent an alias-based expression from becoming a declared property with
the same semantics.

**Graph SQL** is the uniform interface this spec's dialect is chosen for:

```ts
// Actor-bound top-level SQL over objects, relationships and datasets.
await ana.query({
  sql: `SELECT COUNT(*) FROM datasets.Events AS e WHERE e.eventType = 'login'`,
});
// Needs an Events row policy (see Authorization). Does not inherit a filter
// from any object read.

// "How many customers have logged in more than 10 times?"
await ana.query({
  sql: `SELECT COUNT(*) FROM objects.Customer AS c
        WHERE (SELECT COUNT(*) FROM c.events AS e
               WHERE e.eventType = 'login') > 10`,
});
```

Object `get`/`query` remain when graph SQL arrives.

**Synchronization** will own ingestion, watermarks and immutable snapshot
versions. A query resolves each dataset to one snapshot and cites it: a query
that starts on snapshot A (two Acme logins) still reads A after B (three)
publishes. That replaces `freshness: 'unverified'` with verified freshness.

**Other backends** (DuckDB over local files and Parquet, BigQuery, Athena,
third-party APIs) implement `AnalyticalBackend`. An API backend translates the
representation into requests and does not need to parse SQL. A backend that
cannot execute an expression exactly returns `not-supported`, never an
approximation or an unbounded download. For DuckDB specifically the earlier
draft settled three points worth keeping: files are opened read-only and updated
by atomic replacement, because DuckDB allows one writer per file; lockdown
(`enable_external_access = false`, extension autoloading off,
`lock_configuration = true`) is part of acceptance, not left to parsing; and the
DuckDB version is pinned because its parser output changes between releases.
DuckDB also adds a native addon to a stack that is otherwise pure JavaScript
plus built-in SQLite, which is why it is not first.

## Ownership

| Area                                               | Owns                                                                                                                                                                                   |
| -------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/relate`                                  | `defineDataset`, `datasets` associations, `bind`, Relate SQL representation, typed `compute`, `where` and `orderBy` options, conformance corpus, `decodeComputed` in `relate/consumer` |
| `packages/protocol`                                | `AnalyticalExpression`, `orderBy`, `meta.computed`, computed `FieldEvidence`, discovery and `RequestIssue` additions                                                                   |
| `packages/runtime`                                 | Resolution, policy, correlation batching, computed filter and order, orchestration, limits and queueing, evidence                                                                      |
| `packages/node`                                    | Parser and backend injection, bindings, lifecycle, reload                                                                                                                              |
| New parser package (name open)                     | libpg_query WASM adapter; the only place parser node types appear                                                                                                                      |
| `connectors/postgres` (new), `connectors/sqlite`   | `AnalyticalBackend` implementations and their generation suites                                                                                                                        |
| `packages/client`, `packages/http`, `packages/mcp` | Carry the contract; no SQL semantics of their own                                                                                                                                      |
| `packages/postgres`                                | Existing persistence; observation scope key becomes connection plus resource                                                                                                           |

`relate`, `relate/consumer` and `packages/protocol` stay free of parser, `pg`,
`node:sqlite` and Node. An architecture check enforces it.

## Delivery

0. **Rename first, as its own change (Proposed):** `connect` → `bind`,
   `connections` → `bindings`, `connectionId` on the connection, observation
   scope by connection plus resource with its migration. Update examples and
   docs. No analytical code.
1. **Spike:** libpg_query WASM parse cost and output, the batching SQL on
   Postgres and SQLite, parameter typing, result-type checks, cancellation,
   queueing, and computed filter and order over the scope limit.
2. **Contracts:** policy syntax, column IDs, evidence and error shapes, the type
   tables and identifier rules, the corpus format, adjusted by spike findings.
3. **Build:** declarations and protocol, then runtime and backends, through the
   public object consumer path, including `decodeComputed`.
4. **Ship:** discovery, MCP, Inspector, docs, and an example using a general
   `events` table in the example's SQLite file with a caller-side login filter.

## Acceptance criteria

Every row of the tables in [Failures and errors](#failures-and-errors),
[Column types](#column-types-proposed), [JSON encoding](#json-encoding-agreed)
and [Host limits](#host-limits-and-concurrency) has a test. Beyond those, using
the running example:

- Ana's `Customer.query` with `loginsOct` returns Acme `'2'`, Globex `'1'`,
  Initech `'0'`, and does not return Umbrella. No `loginCount` property is
  declared.
- `where: { loginsOct: { eq: '0' } }` returns only Initech;
  `orderBy: [{ field: 'lastLogin', direction: 'desc' }]` returns Acme, Globex,
  Initech, with the null last; paging through that order with a cursor neither
  skips nor repeats an object while data is unchanged.
- A failing statement on an alias used in `where` fails the query with
  `incomplete` even when `requireComplete` is unset.
- Values are independent of page size. A page runs one statement per association
  per connection, however many aliases it carries.
- Fin gets `invalid-request` for `self.events`. Ana's `COUNT(DISTINCT e.userId)`
  is `forbidden`. Umbrella via `get` is `not-found`, with no statement run.
- `WHERE e.eventType = 'login' OR 1 = 1` still counts only Acme's events.
- A graph with an association and no `datasets.events` policy fails to compile
  with `policy.missing`.
- `meta.computed` is present in compact and full modes. Full evidence reports
  `source: 'computed'`, `freshness: 'unverified'`, `readAt`, and `modifiedAt` on
  SQLite.
- `decodeComputed` returns `2n` for `loginsOct` and a `Date` for `lastLogin`.
- The same corpus passes on Postgres and SQLite with identical JSON.
- Embedded, HTTP and MCP callers get identical validation and errors.
- Parser and driver types never appear outside their packages (architecture
  check). Calls without `compute` behave as before.

## Decisions

| Decision                                                                                                                                          | Status   |
| ------------------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| Datasets are separate from objects: no adoption, no object IDs, no persisted values                                                               | Agreed   |
| SQL is the expression language; Postgres grammar is the dialect ([why](#outcome))                                                                 | Agreed   |
| Declared computed properties are a planned extension, not v1 ([shape](#future-declared-computed-properties-graph-sql-sync-and-other-backends))    | Agreed   |
| `defineDataset`, object `datasets` associations with `on`, SQL `self.<association>`                                                               | Agreed   |
| `bind(definition, resource)`; setup returns `bindings`; `connectionId` lives on the connection                                                    | Agreed   |
| `compute` on `get` and `query` means one value per object, never a collection total                                                               | Agreed   |
| [`query` may filter and order by computed aliases](#filtering-and-ordering-by-computed-fields); such aliases are required                         | Agreed   |
| [Aggregate-only SQL subset](#sql-subset)                                                                                                          | Agreed   |
| [Postgres and SQLite are the first backends; DuckDB is deferred](#backends-in-v1)                                                                 | Agreed   |
| Analytical inputs are assumed fresh; no watermarks, sync or cached results in v1                                                                  | Agreed   |
| [Int64 and exact decimals are JSON strings; `COUNT` is always a string; a decoder ships in v1](#decoding-computed-values-agreed-in-this-revision) | Agreed   |
| Failure omits the field and marks the read partial; never `0` or `null` in its place                                                              | Agreed   |
| [Failure granularity is per page and per alias](#failures-and-errors)                                                                             | Agreed   |
| [Association policy separate from dataset policy; missing policy is a compile error](#authorization)                                              | Agreed   |
| [Gates hide, groups refuse](#authorization)                                                                                                       | Agreed   |
| [Host limit defaults](#host-limits-and-concurrency)                                                                                               | Agreed   |
| [Vocabulary: expression, alias, computed field](#terms)                                                                                           | Agreed   |
| Relate-defined views, top-level graph SQL, sync, traversal compute, ordering by properties                                                        | Deferred |
| [Explicit column IDs and access groups in `defineDataset`](#declaring-a-dataset)                                                                  | Proposed |
| [Column type tables and bind-time schema checks](#column-types-proposed)                                                                          | Proposed |
| [Logical types of object properties](#logical-types-of-object-properties-proposed)                                                                | Proposed |
| [Relate-owned result types for each aggregate](#result-type-of-each-expression-proposed)                                                          | Proposed |
| [`meta.computed` carries types in every evidence mode](#types-in-every-response-proposed)                                                         | Proposed |
| [Computed evidence with `freshness: 'unverified'`, `readAt` and `modifiedAt`](#evidence)                                                          | Proposed |
| [libpg_query WASM as the parser](#pipeline)                                                                                                       | Proposed |
| [`bind`/`bindings` rename ships first, as its own change](#delivery)                                                                              | Proposed |

## Open questions

Each question names the delivery step that settles it.

1. The `decimal(...)` helper name, and whether `AVG(decimal)` scale `s + 4`
   matches what Postgres returns exactly. (Spike.)
2. Policy syntax details: nesting association policy under the object versus a
   top-level key, and how column `access` interacts with field groups from
   `defineAccess`. (Contracts.)
3. Connector and resource interface names, and the capability contract that lets
   one connection serve sources and datasets without merging provider scopes.
   (Contracts.)
4. Exact protocol names: unavailable reasons, `location` units, the
   `meta.computed` key, expression identity. (Contracts.)
5. Identifier rules and the exact cast set, fixed by the corpus. (Spike.)
6. `decodeComputed`: name, and whether int64 values come back as plain `bigint`
   or wrapped with `toNumber()`. (Contracts.)
7. libpg_query WASM load time and bundle size, and whether the fallback parser
   is needed. (Spike.)
8. Whether the computed scope limit should be per actor or per host, and whether
   a backend push-down of computed filters is worth it before graph SQL.
   (Spike.)
9. Name of the new parser package and of the Postgres connector package.
   (Build.)

## Revision notes (2026-10-18)

Revised after review on the day it was agreed. Changes from the first draft:

- **Backends.** Postgres and SQLite replace DuckDB as the first backends; both
  are already dependencies and need no native build. DuckDB, its file
  replacement pattern and lockdown moved to Future.
- **Parser.** libpg_query via WASM replaces DuckDB's `json_serialize_sql`.
  Postgres grammar is Relate's dialect for these expressions and for the planned
  graph-wide SQL API. The reason for SQL at all is recorded in Outcome.
- **Filter and order.** `query` accepts computed aliases in `where` and in a new
  `orderBy`. Such aliases are required. The execution section defines the
  candidate-set path and the scope limit.
- **Declared computed properties** are recorded as a planned extension with
  their shape, so v1 contracts leave room for them.
- **Freshness.** Evidence gains `readAt` and optional `modifiedAt`; discovery
  states that inputs are unverified; the `evidenceMaxAgeMs` boundary must be
  documented.
- **Policy.** A missing association or dataset policy is a compile error, as for
  objects. Gates hide, groups refuse, recorded as agreed.
- **Decoder.** `decodeComputed` ships in v1.
- **Host limits** have defaults and a concurrency model with a `busy` reason.
- **Failures.** Granularity is per page and per alias; the two timeout clocks
  are distinguished.
- **Types.** Object property logical types and the parameter and literal input
  encoding are specified.
- **Conformance corpus** is defined and owned.
- **Document.** Outcome section added, Decisions moved after the body, terms and
  statuses tabulated, running example closed (`customerSince` added, extras
  marked), `page.items` corrected to `page.data`, vocabulary reduced to
  expression, alias and computed field.

## References

- [libpg_query](https://github.com/pganalyze/libpg_query) and its
  [WASM binding](https://github.com/constructive-io/libpg-query-node): the
  proposed parser.
- [node-postgres int8 handling](https://github.com/brianc/node-pg-types) and
  [`node:sqlite` `readBigInts`](https://nodejs.org/api/sqlite.html): precedent
  for string and bigint handling of exact values.
- [SQLite aggregate `FILTER` clause](https://www.sqlite.org/lang_aggfunc.html#aggfilter):
  available since 3.30.
- [Securing DuckDB](https://duckdb.org/docs/current/operations_manual/securing_duckdb/overview)
  and [DuckDB concurrency](https://duckdb.org/docs/current/connect/concurrency):
  kept for the deferred DuckDB backend.
- Parser alternatives considered: DuckDB
  [`json_serialize_sql`](https://duckdb.org/docs/current/data/json/sql_to_and_from_json)
  (needs a DuckDB instance), [SQLGlot](https://github.com/tobymao/sqlglot)
  (Python runtime cost),
  [DataFusion sqlparser-rs](https://github.com/apache/datafusion-sqlparser-rs).
