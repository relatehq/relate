# 2026-10-18: Analytical datasets and computed object properties

**Status:** direction and authoring API agreed on 2026-10-18; not implemented.
Revised the same day after review: dataset policy, result typing, bind-time
schema checks and computed-field evidence are now proposed contracts (marked
**Proposed** below). [Decisions](#decisions) lists what is agreed and what still
needs confirmation.

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
// page.items.map((c) => c.data):
// [ { name: 'Acme',    loginsOct: '2' },
//   { name: 'Globex',  loginsOct: '1' },
//   { name: 'Initech', loginsOct: '0' } ]
```

The rows come from an `events` table in a DuckDB file. Those rows are not
adopted, have no Relate IDs, and are never written to the customer. The value is
computed per customer, per read, over the event rows Ana may use.

The rest of this spec explains each piece: how the developer declares the
dataset and links it to Customer (`self.events`), how it is bound to DuckDB, who
may use it, what types and evidence come back, and what happens when something
fails.

## Running example

All examples use this data.

**Customers** (CRM source, `crm.customers`). Ana is an account manager in
`portfolio_north`; Fin works in finance in the same portfolio.

| CRM key        | name     | portfolio         |
| -------------- | -------- | ----------------- |
| `crm_acme`     | Acme     | `portfolio_north` |
| `crm_globex`   | Globex   | `portfolio_north` |
| `crm_initech`  | Initech  | `portfolio_north` |
| `crm_umbrella` | Umbrella | `portfolio_south` |

**Events** (`analytics.duckdb`, table `events`):

| customer_id    | event_type  | occurred_at            | user_id |
| -------------- | ----------- | ---------------------- | ------- |
| `crm_acme`     | `login`     | `2026-09-28T08:00:00Z` | `u_1`   |
| `crm_acme`     | `login`     | `2026-10-02T09:00:00Z` | `u_1`   |
| `crm_acme`     | `login`     | `2026-10-09T10:30:00Z` | `u_2`   |
| `crm_acme`     | `page_view` | `2026-10-09T10:31:00Z` | `u_2`   |
| `crm_globex`   | `login`     | `2026-10-03T14:00:00Z` | `u_7`   |
| `crm_umbrella` | `login`     | `2026-10-04T11:00:00Z` | `u_9`   |

Initech has no events. Umbrella is outside Ana's portfolio.

| Calculation for Ana                                | Acme                         | Globex                       | Initech | Umbrella     |
| -------------------------------------------------- | ---------------------------- | ---------------------------- | ------- | ------------ |
| October logins, `COUNT(*)`                         | `"2"`                        | `"1"`                        | `"0"`   | not returned |
| All-time logins                                    | `"3"`                        | `"1"`                        | `"0"`   | not returned |
| Distinct October users, `COUNT(DISTINCT e.userId)` | `"2"`                        | `"1"`                        | `"0"`   | not returned |
| Last login, `MAX(e.occurredAt)`                    | `"2026-10-09T10:30:00.000Z"` | `"2026-10-03T14:00:00.000Z"` | `null`  | not returned |

## Decisions

| Decision                                                                                       | Status   |
| ---------------------------------------------------------------------------------------------- | -------- |
| Datasets are separate from objects: no adoption, no object IDs, no persisted values            | Agreed   |
| `defineDataset`, object `datasets` associations with `on`, SQL `self.<association>`            | Agreed   |
| `bind(definition, resource)`; setup returns `bindings`; `connectionId` lives on the connection | Agreed   |
| `compute` on `get` and `query` means one value per object, never a collection total            | Agreed   |
| Aggregate-only SQL subset (below); DuckDB parser behind a Relate-owned adapter                 | Agreed   |
| DuckDB is the first backend: local database files and registered Parquet files                 | Agreed   |
| Analytical inputs are assumed fresh; no watermarks, sync or cached results in v1               | Agreed   |
| Int64 and exact decimals are JSON strings; `COUNT` is always a string                          | Agreed   |
| Failure omits the field and marks the read partial; never `0` or `null` in its place           | Agreed   |
| Relate-defined views, top-level graph SQL, sync, filtering or sorting by computed values       | Deferred |
| [Association policy separate from dataset policy](#authorization)                              | Proposed |
| [Explicit column IDs and access groups in `defineDataset`](#declaring-a-dataset)               | Proposed |
| [Allowed column types and bind-time schema checks](#binding-and-schema-checks)                 | Proposed |
| [Relate-owned result types for each aggregate](#result-types-and-encoding)                     | Proposed |
| [`meta.computed` carries types in every evidence mode](#result-types-and-encoding)             | Proposed |
| [Computed evidence reports `freshness: 'unverified'`](#evidence)                               | Proposed |
| [DuckDB files opened read-only; updates by file replacement](#duckdb-files-and-updates)        | Proposed |
| [`bind`/`bindings` rename ships first, as its own change](#delivery)                           | Proposed |

## Terms

| Term               | Meaning                                                    | Running example                               |
| ------------------ | ---------------------------------------------------------- | --------------------------------------------- |
| Connector          | Integration code for a database or API                     | the DuckDB connector                          |
| Connection         | A configured connector instance; owns access and lifecycle | `duckdb({ connectionId: 'analytics', path })` |
| Resource           | An existing table, file or API resource on a connection    | the `events` table                            |
| Source definition  | Unbound contract for keyed records that back objects       | `crm.customers`                               |
| Dataset definition | Unbound contract for analytical rows                       | `analytics.events`                            |
| Binding            | Maps a source or dataset definition to a resource          | `bind(Events, analytics.table('events'))`     |
| Association        | Declared correlation between an object and dataset rows    | `Customer.events`, on the CRM key             |

## What exists today

- [Read and query options](../packages/relate/src/operations.ts) select declared
  properties and filter adopted members. No calculations, no aggregates.
- [`SourceConnector`](../packages/relate/src/connectors.ts) fetches one record
  by key. It has no analytical capability.
- [`connect(...)`](../packages/relate/src/app.ts) returns a per-source binding
  named `Connection`, and setup returns `connections`. This spec renames both.
- [`FieldEvidence`](../packages/protocol/src/index.ts) describes native or
  source observations only.

The [README status table](../README.md#status) stays unchanged until this ships.

## Declaring a dataset

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

### Allowed column types (Proposed)

| Zod declaration                                  | Logical type   | DuckDB physical type |
| ------------------------------------------------ | -------------- | -------------------- |
| `z.boolean()`                                    | boolean        | `BOOLEAN`            |
| `z.string()`                                     | string         | `VARCHAR`            |
| `z.int32()`                                      | int32          | `INTEGER`            |
| `z.int64()`                                      | int64          | `BIGINT`             |
| `z.number()`                                     | float64        | `DOUBLE`             |
| `decimal(18, 2)` (Relate helper; name open)      | decimal(18, 2) | `DECIMAL(18,2)`      |
| `z.iso.datetime({ offset: true, precision: 3 })` | timestamp (ms) | `TIMESTAMPTZ`        |
| `z.iso.datetime({ offset: true, precision: 6 })` | timestamp (µs) | `TIMESTAMPTZ`        |
| `.nullable()` on any of the above                | nullable       | nullable column      |

Object properties keep today's single timestamp format
(`packages/relate/src/portable-schema.ts:113`). Datasets also accept microsecond
precision because analytical stores commonly use it. A `TIMESTAMP` column
without a time zone is rejected; Relate does not guess a zone.

## Associating a dataset with an object

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
- Composite keys use several entries:
  `on: { tenantId: 'tenantId', customerId: 'externalId' }`.
- **Proposed:** both sides must have the same logical type. `string = int64` is
  a compile error; there is no implicit cast.
- **Proposed:** the target property need not be unique. Two customers sharing an
  `externalId` both receive the value computed for that key.
- The association is a model fact, so it appears in discovery. Correlating
  objects to rows only inside caller SQL is not an accepted alternative.

## Binding and schema checks

In application setup:

```ts
const crm = sqlite({ connectionId: 'crm', path: './crm.sqlite' });
const analytics = duckdb({
  connectionId: 'analytics',
  path: './analytics.duckdb',
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
    // A registered Parquet file on the same connection (API shape open):
    // bind(PageViews, analytics.parquet('./page_views/*.parquet')),
  ],
};
```

- `columns` is needed only where physical names differ from declared names.
- One connection serves many bindings. A connector implements each capability
  explicitly: keyed reads for sources, analytical execution for datasets.
  Binding `customerRecords` to a DuckDB table fails unless the DuckDB connector
  also implements keyed reads.
- Paths, tables and credentials are host configuration. Caller SQL can only name
  declared datasets through `self.<association>`.
- Persisted observations are currently scoped by `connectionId`
  (`packages/postgres/src/index.ts:70`). Once one connection serves several
  bindings, the scope key must become connection plus resource, so that two
  tables on one connection never share observations.

**Proposed bind-time check.** When the runtime starts, and whenever a bound file
is replaced, the connector reports the physical schema. Relate compares it with
the declaration and refuses the binding on a mismatch:

```text
Binding analytics.events → analytics:events is invalid:
  occurredAt: declared timestamp (ms, with offset), found TIMESTAMP
    (no time zone). Store TIMESTAMPTZ or convert in the source table.
  customerId: declared non-nullable, found nullable VARCHAR.
    Declare z.string().nullable() or add NOT NULL.
```

Rows are not validated individually; at analytical scale that is a scan.
Declared types are trusted once the physical schema matches.

## Authorization

Reading a customer does not authorize reading its events. A computation needs
three checks: the customer is visible, the association may be used, and every
referenced column is readable. That includes columns used only in `WHERE`.

**Proposed policy shape.** Association policy and dataset policy are separate:

```ts
policies: {
  Customer: {
    read: {
      gate: access.role('employee'),
      where: { portfolio: { eq: access.claims.portfolio } },
      evidenceMaxAgeMs: 30000,
    },
    // Who may compute over Customer.events, i.e. use self.events.
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
using one never implies the other. With neither policy declared, access is
denied.

What each actor gets for `loginsOct` on Acme:

| Actor | Roles                        | Result                                                                                             |
| ----- | ---------------------------- | -------------------------------------------------------------------------------------------------- |
| Ana   | employee, account-manager    | `loginsOct: '2'`                                                                                   |
| Fin   | employee, finance            | `invalid-request`: `self.events` is not in Fin's discovery, so it is reported like an unknown name |
| Ana   | (`COUNT(DISTINCT e.userId)`) | field omitted; evidence `{ status: 'forbidden' }`, because `userId` is in `identifying`            |
| Ana   | Umbrella's ID with `get`     | `{ status: 'not-found' }`; no analytical query runs                                                |

- **Proposed:** an association the actor may not use is absent from their
  discovery, so a reference to it fails like an unknown name. A column the actor
  may not read is listed in discovery with its access requirement, so the
  computation is `forbidden`, like selecting a restricted property.
- Caller SQL cannot weaken scope. Relate ANDs the correlation and policy
  predicates outside the caller's `WHERE`, so `OR 1 = 1` widens nothing.
- A correlation property that is forbidden, unavailable, stale-omitted, null or
  absent makes the computation `unavailable`. It never widens the scan and never
  yields `0`.
- Tenancy is not assumed. One database may hold events for many customers. A
  tenant rule, where one exists, is ordinary dataset or association policy.

## Calling it

```ts
interface AnalyticalExpression {
  readonly sql: string;
  readonly parameters?: Readonly<Record<string, Json>>;
}

interface AnalyticalReadOptions {
  readonly compute?: Readonly<Record<string, AnalyticalExpression>>;
}
```

`compute` is added to object `get` and `query` options only, not to traversal,
source fetch or action input. The same JSON travels across the embedded, HTTP
and MCP paths, and every execution boundary validates it.

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
// initech.data: { name: 'Initech', lastLogin: null }   ← no logins; valid SQL null
```

### `self`

- `self.events` means "rows of the `events` association for this object". It
  applies `Events.customerId = self.externalId`.
- `self.<property>` reads a property of the current object, under ordinary
  authorization and freshness. It need not be selected and is not returned:

  ```sql
  SELECT COUNT(*) FROM self.events AS e
  WHERE e.eventType = 'login' AND e.occurredAt >= self.createdAt
  ```

- `self` is reserved. It is not a table or a parameter, and aliases cannot
  shadow it.

### Parameters

- Values only. A parameter cannot stand in for a table, column, SQL fragment or
  `self`.
- Types come from context: `$since` compared with `occurredAt` is a timestamp,
  so `'2026-10-01T00:00:00Z'` is parsed as an instant. An ambiguous parameter,
  such as `SELECT $x`, is rejected unless explicitly `CAST`.

### Collection semantics

| Operation                                   | Ana's result                            |
| ------------------------------------------- | --------------------------------------- |
| `Customer.get(acmeId)` with `loginsOct`     | Acme, `loginsOct: '2'`                  |
| `Customer.query()` with `loginsOct`         | Acme `'2'`, Globex `'1'`, Initech `'0'` |
| Total October logins across Ana's customers | `'3'`: future graph SQL, not `compute`  |

- `self` is always one object, never the matching collection.
- Paging selects customers first. Each value covers that customer's full
  authorized event scope, not a page of events. `compute` never changes
  membership or order.
- `compute` adds result fields; it does not change what `select` means. Calls
  without `compute` behave exactly as today.
- An alias may not equal any declared property name, selected or not, and must
  be safe as an object key (`__proto__` is rejected).
- Two aliases with the same expression are computed independently. Aliases are
  not stable IDs and cannot reference each other.
- Different pages and different connections are not one snapshot.

## SQL subset

Agreed scope for v1:

- One `SELECT` with one output column, `FROM self.<association>` with an
  optional alias.
- `COUNT(*)`, `COUNT(x)`, `COUNT(DISTINCT x)`, `SUM`, `AVG`, `MIN`, `MAX`.
- In `WHERE`: typed comparisons, `AND`, `OR`, `NOT`, `IS [NOT] NULL`.
- Column references, `self.<property>`, literals, `$named` parameters,
  `COALESCE(<aggregate>, <literal>)`, and the casts listed in the conformance
  corpus.

Rejected: joins, CTEs, subqueries, `GROUP BY`, windows, `UNION`, `ORDER BY`,
`LIMIT`, table functions, UDFs and anything other than a query. An unknown node
fails closed.

```sql
-- Accepted
SELECT COUNT(DISTINCT e.userId) FROM self.events AS e
WHERE e.eventType = 'login' AND e.occurredAt >= $since

-- Rejected: not-supported (must return one value per customer)
SELECT e.eventType, COUNT(*) FROM self.events AS e GROUP BY e.eventType

-- Rejected: not-supported (table function; also blocked at the backend)
SELECT COUNT(*) FROM read_parquet('/etc/*')
```

Empty input still returns one row: `COUNT` is `'0'`; `SUM`, `AVG`, `MIN` and
`MAX` are `null`. `COUNT(*)` counts duplicate rows, `COUNT(x)` skips nulls and
`COUNT(DISTINCT x)` counts distinct non-null values.

## Result types and encoding

### Result type of each expression (Proposed)

Relate decides the result type from the declared input types. The backend's
native result type is checked against it, never passed through. This keeps the
JSON encoding identical across backends: DuckDB's `SUM(INTEGER)` is `HUGEINT`
while Postgres's is `int8`, but both return a Relate int64.

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
it is `"0"`.

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

TypeScript typing of `data` for computed aliases is the JSON scalar union. An
SDK decoder can turn int64 into `bigint` and decimals into strings or a
caller-chosen decimal type. Conversion to `number` is explicit and
range-checked. A validated result-schema helper is an open API question.

## Evidence

**Proposed.** `FieldEvidence` gains a computed variant. It does not pretend to
be a source observation:

```ts
type FieldEvidence =
  | { status: 'forbidden' }
  | { status: 'unavailable'; reason?: ComputedUnavailableReason }
  | {
      status: 'available' | 'absent';
      source: 'native' | 'source'; /* … as today */
    }
  | {
      status: 'available';
      source: 'computed';
      freshness: 'unverified'; // input assumed current; nothing checked
      computedAt: string;
      inputs: {
        associationId: string; // 'business.customer.events'
        datasetId: string; // 'analytics.events'
        bindingRevision: string; // changes when the binding or file changes
      }[];
      coverage: 'complete'; // every row in the authorized scope was evaluated
      dependencies: Record<string, FieldEvidence>; // e.g. externalId
    };
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
      "bindingRevision": "sha256:…"
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

- `'unverified'` exists because v1 assumes analytical inputs are current and
  checks nothing. Reporting `'fresh'` would be the exact false claim evidence
  exists to prevent. Synchronization will introduce verified freshness.
- `coverage: 'complete'` means every row in the authorized scope was read. It
  does not mean the table holds every real-world login.
- `evidenceMaxAgeMs`, `maxAgeMs`, `refresh` and `stale` apply to `dependencies`
  only. A policy author who sets `evidenceMaxAgeMs: 30000` on Customer gets that
  bound on `externalId`, not on the event count. Policy docs must say so.
- Raw SQL, parameter values, paths and credentials never appear in evidence or
  activity. A public calculation identity, if added, must not hash guessable
  parameters.
- No results are cached across requests in v1. Within one request, identical
  expression, parameters, correlation key, actor scope and binding may be
  computed once.

## Failures and errors

| Situation                                                                      | Outcome                                                                  |
| ------------------------------------------------------------------------------ | ------------------------------------------------------------------------ |
| Bad SQL, unsupported construct, alias collision, missing or mistyped parameter | Request rejected with `invalid-request` before any execution             |
| Column not readable by the actor                                               | Field omitted, `forbidden`; read is `partial`                            |
| Correlation property unavailable or null                                       | Field omitted, `unavailable` (`reason: 'correlation-unavailable'`)       |
| DuckDB file missing, locked, or query fails                                    | Field omitted, `unavailable` (`reason: 'execution-failed'`, `retryable`) |
| Overflow, NaN, unsupported temporal value                                      | Field omitted, `unavailable` (`reason: 'invalid-result'`)                |
| Any of the above with `requireComplete: true`                                  | `ReadError('incomplete')` naming the alias and reason                    |
| Timeout or cancellation                                                        | The operation's error, never a partial count                             |
| Valid empty input                                                              | `'0'` for `COUNT`, `null` for the others; not a failure                  |

Errors extend today's `RequestIssue`
([`packages/protocol/src/index.ts`](../packages/protocol/src/index.ts)) with SQL
location and a suggestion:

```ts
{
  code: 'invalid-request',
  operation: 'Customer.get',
  issues: [{
    path: ['compute', 'loginsOct', 'sql'],
    problem: 'unknown-column',
    message: 'Unknown column occuredAt on self.events. Did you mean occurredAt?',
    location: { line: 2, column: 15 }, // units to be fixed in protocol review
    accepted: ['customerId', 'eventType', 'occurredAt', 'userId'],
    suggestion: 'occurredAt',
  }],
}
```

Suggestions come only from the actor's discovery. Execution failures are never
reported as bad SQL, so an agent does not keep rewriting a correct query during
an outage.

## How a query page executes

```text
SQL + parameters
  → parser adapter (DuckDB json_serialize_sql)
  → Relate SQL representation      (no DuckDB nodes)
  → resolve names, types, policy   → authorized dataset query
  → backend SQL generation         (never the caller's original string)
  → execute, validate result types → values + evidence
```

```ts
interface SqlParser {
  parse(sql: string): Promise<RelateSqlQuery>;
}

interface AnalyticalBackend {
  plan(request: AuthorizedDatasetQuery): Promise<DatasetPlanResult>;
  execute(
    plan: PreparedDatasetPlan,
    options: { signal: AbortSignal },
  ): Promise<DatasetQueryResult>;
}
```

Only the runtime constructs `AuthorizedDatasetQuery`; it is never accepted from
a wire. The parser adapter and backend adapter are separate contracts, even
while both use DuckDB. Swapping the parser means passing the same conformance
corpus.

**One query per page, not per customer.** For Ana's query page, Relate first
reads the three customers and their `externalId`s, then generates roughly:

```sql
WITH keys(slot, k0) AS (
  VALUES (0, 'crm_acme'), (1, 'crm_globex'), (2, 'crm_initech')
),
agg AS (
  SELECT e.customer_id AS k0, COUNT(*) AS v
  FROM events AS e
  WHERE e.customer_id IN (SELECT k0 FROM keys)           -- correlation, outside
    AND (e.event_type = 'login'                          -- caller WHERE, wrapped
         AND e.occurred_at >= $1 AND e.occurred_at < $2)
  GROUP BY e.customer_id
)
SELECT keys.slot, COALESCE(agg.v, 0) AS v               -- COUNT: empty group is 0
FROM keys LEFT JOIN agg USING (k0)
ORDER BY keys.slot;
-- slot 0 → 2, slot 1 → 1, slot 2 → 0
```

For `SUM`, `AVG`, `MIN` and `MAX`, an empty group stays `NULL`.
`self.<property>` references become extra columns in `keys`. Every customer on
the page gets exactly one value, including Initech with no events.

## DuckDB files and updates

**Proposed.** DuckDB allows one read-write process per database file, or many
read-only ones. If an ingestion job holds `analytics.duckdb` open for writing,
Relate cannot open it. Supported patterns for v1:

| Input                                 | How it stays current                                                                                                                                                        |
| ------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `.duckdb` file                        | Relate opens it read-only. The writer builds a new file and renames it into place; Relate detects the change, reopens, and lets in-flight queries finish on the old handle. |
| Parquet files                         | Read at query time. Writers add or replace files atomically.                                                                                                                |
| A database the app writes to in place | Not supported in v1.                                                                                                                                                        |

Each replacement changes `bindingRevision` and re-runs the bind-time schema
check.

**Lockdown** is part of the spike's acceptance, not left to parser validation:

```sql
SET enable_external_access = false;      -- after trusted files are registered
SET autoload_known_extensions = false;
SET autoinstall_known_extensions = false;
SET allow_community_extensions = false;
SET memory_limit = '512MB';              -- host-configured
SET threads = 2;                         -- host-configured
SET lock_configuration = true;           -- last: caller SQL cannot SET anything
```

Cancellation uses DuckDB's connection interrupt; if a query does not stop within
a bound, the worker running it is terminated. Host limits cover SQL length, AST
size, parameter size, computations per request, execution time and memory. A
caller timeout can tighten these limits, never raise them. The DuckDB version is
pinned because the `json_serialize_sql` output can change between releases; the
conformance corpus gates upgrades.

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
    "example": "SELECT COUNT(*) FROM self.events AS e WHERE e.eventType = 'login'"
  }
}
```

Fin's discovery has no `datasets.events`.

**Activity** ([2026-10-13 spec](./2026-10-13-activity.md)). A read with
`compute` records the association and dataset IDs used, the number of
computations, and the failure reason of each failed one. It records no SQL,
parameters or aliases.

**Inspector.** Shows datasets as nodes with association edges to objects, and
columns with their access groups. Exact presentation is left to the Inspector.

## Future: graph SQL, sync and other backends

Not in v1; recorded so the v1 boundaries leave room for them.

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
// Filters objects by a computed value, which v1 compute cannot do.
```

- **Synchronization** will own ingestion, watermarks and immutable snapshot
  versions. A query resolves each dataset to one snapshot and cites it: a query
  that starts on snapshot A (two Acme logins) still reads A after B (three)
  publishes. That replaces `freshness: 'unverified'` with verified freshness.
- **Other backends** (Postgres, BigQuery, Athena, third-party APIs) implement
  `AnalyticalBackend`. An API backend translates the representation into
  requests and does not need to parse SQL. A backend that cannot execute an
  expression exactly returns `not-supported`, never an approximation or an
  unbounded download.
- Object `get`/`query` remain when graph SQL arrives.

## Ownership

| Area                                               | Owns                                                                                                      |
| -------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `packages/relate`                                  | `defineDataset`, `datasets` associations, `bind`, Relate SQL representation, typed `compute` option       |
| `packages/protocol`                                | `AnalyticalExpression`, `meta.computed`, computed `FieldEvidence`, discovery and `RequestIssue` additions |
| `packages/runtime`                                 | Resolution, policy, correlation batching, orchestration, evidence                                         |
| `packages/node`                                    | Parser/backend injection, bindings, lifecycle                                                             |
| New DuckDB package (name open)                     | Parser adapter and backend adapter, as separate modules; the only place DuckDB types appear               |
| `packages/client`, `packages/http`, `packages/mcp` | Carry the contract; no SQL semantics of their own                                                         |
| `packages/postgres`                                | Existing persistence; observation scope key becomes connection plus resource                              |

`relate`, `relate/consumer` and `packages/protocol` stay free of DuckDB and
Node. An architecture check enforces it.

## Delivery

0. **Rename first, as its own change (Proposed):** `connect` → `bind`,
   `connections` → `bindings`, `connectionId` on the connection, observation
   scope by connection plus resource. Update examples and docs. No analytical
   code.
1. **Spike:** parser extraction, the batching SQL above, parameter typing,
   result-type checks, lockdown settings, cancellation, and file replacement.
2. **Contracts:** policy syntax, column IDs, evidence and error shapes, the type
   table and identifier rules, adjusted by spike findings.
3. **Build:** declarations and protocol, then runtime and backend, through the
   public object consumer path.
4. **Ship:** discovery, MCP, Inspector, docs, and an example using a general
   `events` table with a caller-side login filter.

## Acceptance criteria

Using the running example:

- Ana's `Customer.query` with `loginsOct` returns Acme `'2'`, Globex `'1'`,
  Initech `'0'`, and does not return Umbrella. A `Customer.get` for Acme returns
  `'2'`. No `loginCount` property is declared.
- All-time count is Acme `'3'`; distinct October users is Acme `'2'`;
  `MAX(occurredAt)` for Initech is `null`. Duplicate rows, null `userId` and
  both window boundaries are covered by tests.
- Values are independent of page size, and paging preserves order and
  membership. A page runs one analytical query per connection, not one per
  customer.
- Fin gets `invalid-request` for `self.events`. Ana's `COUNT(DISTINCT e.userId)`
  is `forbidden`. Umbrella via `get` is `not-found`, with no analytical
  execution.
- `WHERE e.eventType = 'login' OR 1 = 1` still counts only Acme's events.
- A nullable physical column declared non-nullable, or a `TIMESTAMP` without a
  zone, fails binding with the actionable message.
- Replacing `analytics.duckdb` changes `bindingRevision` and re-runs the schema
  check; no result is reused across the replacement.
- `meta.computed` is present in compact and full modes. Full evidence reports
  `source: 'computed'`, `freshness: 'unverified'`.
- int64, decimal, timestamp, SQL null, absent and failed values are distinct in
  tests. `SUM` overflow is `unavailable`, not wrapped or widened.
- Timeout, cancellation and budget exhaustion never return a count. Workers and
  connections are cleaned up.
- `read_parquet(...)`, `ATTACH`, `SET`, multiple statements and unknown nodes
  are rejected by the parser adapter _and_ blocked by the backend settings.
- Embedded, HTTP and MCP callers get identical validation and errors.
- DuckDB types never appear outside the DuckDB package (architecture check).
- Calls without `compute` behave as before.

## Open questions

1. The `decimal(...)` helper name, and whether `AVG(decimal)` scale `s + 4`
   matches what DuckDB and Postgres can return exactly.
2. Policy syntax details: nesting association policy under the object versus a
   top-level key, and how column `access` interacts with field groups from
   `defineAccess`.
3. Connector and resource interface names, and the capability contract that lets
   one connection serve sources and datasets without merging provider scopes.
4. Exact protocol names: unavailable reasons, `location` units, the
   `meta.computed` key, calculation identity.
5. Identifier rules: case sensitivity, quoting and reserved words; the exact
   cast set.
6. A typed result-schema helper for `compute`.
7. The Parquet registration API and how file changes are detected.

## References

- [DuckDB SQL to and from JSON](https://duckdb.org/docs/current/data/json/sql_to_and_from_json):
  the initial parser.
- [Securing DuckDB](https://duckdb.org/docs/current/operations_manual/securing_duckdb/overview):
  why statement checks alone are not a boundary.
- [DuckDB concurrency](https://duckdb.org/docs/current/connect/concurrency): the
  single-writer rule behind the file-replacement pattern.
- [node-postgres int8 handling](https://github.com/brianc/node-pg-types) and
  [DuckDB Node type mapping](https://github.com/duckdb/duckdb-node-neo/blob/main/api/pkgs/%40duckdb/node-api/README.md#infer-js-types-from-duckdb-types):
  precedent for string encoding of exact values.
- Parser alternatives considered: [SQLGlot](https://github.com/tobymao/sqlglot)
  (Python runtime cost),
  [DataFusion sqlparser-rs](https://github.com/apache/datafusion-sqlparser-rs),
  [libpg_query](https://github.com/pganalyze/libpg_query) and its
  [WASM binding](https://github.com/constructive-io/libpg-query-node).
