# 2026-10-28: Reference datasets

**Status:** direction agreed on 2026-10-28: keyed datasets that expressions may
join by equality on every key column. Grammar, plan, result and evidence
contracts below are proposed. Nothing is implemented. This extends
[Analytical datasets and computed fields](./2026-10-18-analytical-properties.md),
whose "no joins" rule becomes "no joins except full-key joins to reference
datasets". The [media agency benchmark](./2026-10-23-media-agency-benchmark.md)
needs it for currency conversion before its graph is frozen.

| Part                                                              | Status              |
| ----------------------------------------------------------------- | ------------------- |
| `key` on `defineDataset`; full-key equality joins only            | Agreed 2026-10-28   |
| Missing or duplicate reference rows never silently change a value | Agreed 2026-10-28   |
| SQL name `datasets.<Name>`                                        | Proposed            |
| Arithmetic inside aggregate arguments (`SUM(a * b)`)              | Proposed (required) |
| `date` logical type                                               | Open, lean add      |
| As-of joins ("latest rate on or before")                          | Deferred            |

## The problem

A plan line's budget is in the client's currency, but its delivery rows are in
the ad account's currency, which is different for about a quarter of accounts.
The exchange rate depends on the delivery date. To compare spend with budget,
each delivery row must be multiplied by that day's rate:

```text
plan line PL-0042-07   budget 50,000.00 GBP
delivery 2026-10-01    412.37 EUR   × rate(2026-10-01, EUR→GBP) 0.8612
delivery 2026-10-02    398.10 EUR   × rate(2026-10-02, EUR→GBP) 0.8604
…
```

Today an expression reads exactly one dataset. The rate table cannot be
referenced:

```ts
// rejected today: packages/sql-parser/src/lower.ts:98 allows one FROM item
sql: `SELECT SUM(d.spendMicros * f.rate) FROM self.delivery d JOIN fx f ON …`;
```

So conversion has to happen in caller code, after the aggregate, which is wrong:
the rate changes per row.

## Concepts

The terms build on the dataset concepts from the analytical-properties spec.

| Term                  | Meaning                                                                                                     | Tiny example                                                                          |
| --------------------- | ----------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| **Dataset**           | Typed rows in a SQL table with no Relate identity, declared in the graph and bound to a physical table.     | `Delivery` rows in DuckDB                                                             |
| **Association**       | A link from an object to a dataset by correlation columns; `self.<name>` in SQL means "this object's rows". | `PlanLine.datasets.delivery`, `FROM self.delivery d`                                  |
| **Expression**        | One SQL aggregate over an association, declared (`computed`) or sent by a caller (`compute`).               | `SELECT SUM(d.spendMicros) FROM self.delivery d`                                      |
| **Key**               | Columns that identify at most one row of a dataset.                                                         | `key: ['date', 'fromCurrency', 'toCurrency']`                                         |
| **Reference dataset** | A keyed dataset registered in the graph that expressions may join to. It needs no association.              | `Fx` daily exchange rates                                                             |
| **Base rows**         | The association rows an expression aggregates.                                                              | `self.delivery d`                                                                     |
| **Full-key join**     | A join whose `ON` binds every key column with `=` and nothing else. Matches at most one row.                | `ON f.date = d.date AND f.fromCurrency = d.currency AND f.toCurrency = self.currency` |
| **Lookup semantics**  | A reference join never adds or removes base rows: each base row gets zero or one reference row.             | A missing rate makes the value unavailable, not smaller                               |

Why "full key only": a join on fewer columns can match several rows and multiply
sums. Requiring the full key keeps every aggregate exactly as correct as it was
without the join. Malloy, Looker, Cube, Databricks metric views, Snowflake
semantic views and dbt MetricFlow all model rate tables this way: a standalone
keyed table joined many-to-one from the fact table.

## Authoring

```ts
export const Fx = defineDataset({
  id: 'warehouse.fx-daily',
  description: 'Daily closing rate from one currency to another.',
  key: ['date', 'fromCurrency', 'toCurrency'], // NEW
  columns: {
    date: { id: 'fx.date', schema: z.iso.date(), access: ordinary }, // needs the date type, see below
    fromCurrency: { id: 'fx.from', schema: z.string(), access: ordinary },
    toCurrency: { id: 'fx.to', schema: z.string(), access: ordinary },
    rate: { id: 'fx.rate', schema: z.number(), access: ordinary }, // float64
  },
});

export const PlanLine = defineObject({
  id: 'agency.plan-line',
  membership: source(planLines),
  properties: {
    // …
    platform: from(planLines.fields.platform, {
      id: 'agency.plan-line.platform',
    }),
    platformCampaignId: from(planLines.fields.platform_campaign_id, {
      id: 'agency.plan-line.platform-campaign-id',
    }),
    currency: from(planLines.fields.currency, {
      id: 'agency.plan-line.currency',
    }),
    spendThroughYesterdayMinor: computed({
      id: 'agency.plan-line.spend-through-yesterday-minor',
      access: ordinary,
      sql: `SELECT SUM(d.spendMicros * f.rate) / 10000
            FROM self.delivery AS d
            JOIN datasets.Fx AS f
              ON f.date = d.date AND f.fromCurrency = d.currency AND f.toCurrency = self.currency`,
    }),
  },
  datasets: {
    delivery: {
      id: 'agency.plan-line.delivery',
      dataset: Delivery,
      on: [
        { column: 'platform', property: 'platform' },
        { column: 'platformCampaignId', property: 'platformCampaignId' },
      ],
    },
  },
});

export const graph = defineGraph({
  // …
  datasets: { Delivery, Fx }, // Fx needs no association
  policies: {
    PlanLine: { /* … */ datasets: { delivery: { gate: planner } } },
    Fx: {}, // DatasetPolicy: column groups only, as today
  },
});
```

Callers write the same join:

```ts
await relate.PlanLine.query({
  compute: {
    spendOct: {
      sql: `SELECT SUM(d.spendMicros * f.rate) / 10000 FROM self.delivery AS d
            JOIN datasets.Fx AS f
              ON f.date = d.date AND f.fromCurrency = d.currency AND f.toCurrency = self.currency
            WHERE d.date >= $from`,
      parameters: { from: '2026-10-01' },
    },
  },
});
```

What already works and what is new:

- Registering a dataset in `defineGraph({ datasets })` without any association
  already compiles (`packages/relate/src/compiler/datasets.ts`), and
  `DatasetPolicy` already governs column groups. Those parts need no change.
- New: `key`, the `JOIN` grammar, arithmetic inside aggregates, the plan shape,
  result reasons, evidence and discovery.

## Validation rules

**Key**

- Every key column must be a declared, non-nullable column.
- Columns must be unique, with at least one.
- Bad keys raise a new `dataset.invalid-key` diagnostic.
- An unkeyed dataset cannot be joined.

**Names.** A reference dataset is written `datasets.<RegistryKey>` (for example
`datasets.Fx`). The `datasets` schema is reserved, like `self`, so a join can
never name a physical table. Every column must be qualified by an alias once an
expression has a join.

| Rule        | Accepted                                                                                                                 | Rejected                                                                             |
| ----------- | ------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------ |
| Base        | Exactly one `FROM self.<association> [AS] alias`, as today                                                               | No base; a reference dataset as the base                                             |
| Join target | `datasets.<Name>` where `Name` is a keyed dataset registered in the graph                                                | `self.x`, unkeyed datasets, unqualified or physical names                            |
| `ON` clause | `AND` of `ref.keyColumn = operand` covering every key column once; operand is a base column, `self.property` or `$param` | Missing or repeated key column, `<`, `OR`, functions, extra predicates (use `WHERE`) |
| Join kind   | `JOIN` or `LEFT JOIN`, both with lookup semantics                                                                        | `RIGHT`, `FULL`, `CROSS`, `NATURAL`, `USING`, subqueries, CTEs                       |
| Chaining    | Several reference joins, each `ON` binding only base columns, `self` or parameters                                       | A join whose `ON` uses another reference's columns (v1)                              |
| Types       | Equal logical types on each `ON` pair                                                                                    | Mismatched types (diagnostic)                                                        |
| Connection  | Reference dataset bound to the same connection as the base dataset                                                       | Cross-connection joins (startup diagnostic); federation is separate                  |
| Aliases     | Unique, not `self` or `datasets`                                                                                         | Duplicates                                                                           |

`JOIN` gets lookup semantics, not SQL's inner-join filtering, because filtering
out unmatched rows would silently shrink a sum. Discovery's `ComputeDescription`
text says so.

## Arithmetic inside aggregates

Today an aggregate's argument is a single operand: a column, `self.x`, a
parameter or a constant (`argument: operand(…)`,
`packages/sql-parser/src/lower.ts:394`; `SqlAggregate.argument`,
`packages/relate/src/analytics/sql.ts:77`). Arithmetic is allowed only between
aggregates, as in `SUM(a) / SUM(b)`. Conversion needs it per row, inside the
aggregate:

```ts
// before
interface SqlAggregate { argument: Operand | '*'; … }
// after
interface SqlAggregate { argument: RowExpression | '*'; … }
type RowExpression =
  | Operand
  | { kind: 'arithmetic'; op: '+' | '-' | '*' | '/'; left: RowExpression; right: RowExpression };
```

Typing rules (proposed):

| Operands                | Result                                                 |
| ----------------------- | ------------------------------------------------------ |
| int32/int64 `+ - *` int | int64; overflow → value unavailable `execution-failed` |
| any `/` any             | float64                                                |
| any with float64        | float64                                                |
| null operand            | null row value; `SUM`/`AVG` skip it as today           |

`COUNT(DISTINCT …)` keeps a plain operand. This is also useful without joins,
for example `SUM(d.clicks * 1.0)`.

## Execution

The existing plan correlates each object (a "slot") with its base rows and
aggregates per slot (`packages/relate/src/analytics/render.ts:198`). A reference
join adds one deduplicated reference relation and two guard values per
reference:

```sql
WITH keys(slot, k0, k1, p_currency) AS (VALUES (0, 'meta', 'm_2384001', 'GBP'), (1, 'meta', 'm_2384002', 'EUR')),
fx_k AS (
  SELECT date, from_currency, to_currency, MIN(rate) AS rate, COUNT(*) AS n
  FROM fx_daily
  GROUP BY date, from_currency, to_currency
)
SELECT k.slot,
  SUM(d.spend_micros * f.rate) / 10000      AS value,
  COUNT(*) FILTER (WHERE f.n IS NULL)       AS ref0_missing,  -- base rows with no match
  MAX(f.n)                                  AS ref0_max_n     -- > 1 means the key is violated
FROM keys k
JOIN delivery_daily_campaign d ON d.platform = k.k0 AND d.platform_campaign_id = k.k1
LEFT JOIN fx_k f ON f.date = d.date AND f.from_currency = d.currency AND f.to_currency = k.p_currency
GROUP BY k.slot;
```

- Plain `MIN` and an explicit `GROUP BY` run on DuckDB, SQLite and Postgres.
  `ANY_VALUE` and `GROUP BY ALL` do not.
- The sketch writes guards with `FILTER (WHERE …)` for readability. Renderers
  emit them through `dialect.aggregate`, as they already do for aggregate
  predicates (`render.ts:125`).
- Physical names and mapping stay inside the connector plan, as today.

Plan contract:

```ts
// packages/relate/src/analytics/query.ts (sketch)
export interface AuthorizedDatasetQuery {
  readonly resource: DatasetResource; // base, unchanged
  readonly references: readonly {
    // NEW, in alias order
    readonly resource: DatasetResource;
    readonly key: readonly string[];
    readonly on: readonly {
      readonly column: string;
      readonly operand: ResolvedOperand;
    }[];
  }[];
  // …keys, correlation, slots, aggregates
}

export type ResolvedOperand =
  | {
      kind: 'column';
      relation: 'base' | number;
      column: string;
      type: LogicalType;
    } // relation: NEW
  | { kind: 'key'; key: number; type: LogicalType }
  | { kind: 'value'; value: TypedValue };
```

## Results and evidence

| Situation                                      | Field evidence                                                                              |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------- |
| Every base row matched exactly one row         | `available`, value as computed                                                              |
| Some base row has no reference row             | `unavailable`, reason `reference-missing`. Never a silently smaller sum                     |
| The source violates the declared key (`n > 1`) | `unavailable`, reason `reference-key-not-unique`. Never a duplicated rate                   |
| No base rows at all                            | Unchanged from today's empty-association behavior                                           |
| Caller cannot read a used reference column     | As for any unreadable dataset column today; a calculation never grants access to its inputs |

Protocol changes (`packages/protocol/src`):

```ts
// analytics.ts:21
export type ComputedUnavailableReason =
  | 'correlation-unavailable' | 'execution-failed' | 'invalid-result' | 'busy'
  | 'reference-missing' | 'reference-key-not-unique'; // NEW

// index.ts:84, ComputedFieldEvidence.inputs: one entry per dataset read
readonly inputs: readonly (
  | { role: 'base'; associationId: string; datasetId: string; bindingRevision: string; readAt: string; modifiedAt?: string }
  | { role: 'reference'; alias: string; datasetId: string; bindingRevision: string; readAt: string; modifiedAt?: string } // NEW
)[];

// discovery.ts:96, GraphDescription
readonly datasets?: Readonly<Record<string, ReferenceDatasetDescription>>; // NEW, visible reference datasets only
export interface ReferenceDatasetDescription {
  readonly datasetDefinitionId: string;
  readonly description?: string;
  readonly key: readonly string[];
  readonly columns: Readonly<Record<string, DatasetColumnDescription>>; // visible columns only
}
```

`role` makes `inputs` a discriminated union. That is a breaking change, which is
acceptable before the first release.

## Dates

Joining a rate table by date needs a date column, but there is no date logical
type. `LogicalType` (`packages/protocol/src/analytics.ts:4`) has boolean,
string, int32, int64, float64 and timestamp. `z.iso.date()` is rejected with
"Unsupported dataset scalar format"
(`packages/relate/src/compiler/dataset-types.ts:47`). The same happens to
`z.float64()`, because it carries a format; use `z.number()` for float64.

| Option                           | Sketch                                                           | Cost                                                                                         |
| -------------------------------- | ---------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| A. Add `{ type: 'date' }` (lean) | `date: { schema: z.iso.date() }`; wire value `'2026-10-01'`      | Protocol, value codecs, three connectors' physical checks and comparisons, filters and order |
| B. Dates as ISO strings          | `date: { schema: z.string() }`, physical column `VARCHAR`/`TEXT` | No engine work; equality and range work on `YYYY-MM-DD`; physical `DATE` columns rejected    |

The lean is A, because rate and calendar tables are almost always keyed by a
real `DATE` column. If A does not fit the schedule, B unblocks the benchmark,
which owns its warehouse schema.

## Missing days

Daily rate tables usually skip weekends and holidays, but delivery happens every
day. With strict equality those rows are `reference-missing`. As-of joins
("latest rate on or before this date", DuckDB `ASOF JOIN`) are deferred. Until
then, data owners fill every calendar day, and every currency pair that is used,
including identity pairs (`GBP→GBP = 1`).

## Files

| File                                                            | Change   | Why                                                                 |
| --------------------------------------------------------------- | -------- | ------------------------------------------------------------------- |
| `packages/relate/src/datasets.ts`                               | modified | `key` option; frozen on the definition                              |
| `packages/relate/src/compiler/datasets.ts`                      | modified | Key validation; reference registry for expression preparation       |
| `packages/relate/src/compiler/dataset-types.ts`                 | modified | `date` type (option A)                                              |
| `packages/relate/src/analytics/sql.ts`, `query.ts`              | modified | `RowExpression`; `references` and `relation` in the plan            |
| `packages/sql-parser/src/lower.ts`                              | modified | `JOIN datasets.X`, `ON` lowering, qualified columns, row arithmetic |
| `packages/runtime/src/analytics/resolve.ts`, `prepare-*.ts`     | modified | Resolve reference columns, types and full-key coverage              |
| `packages/runtime/src/authorization/analytics.ts`               | modified | Reference datasets in the expression scope; column authorization    |
| `packages/runtime/src/analytics/execute.ts`, `merge.ts`         | modified | Guard values → `reference-missing` / `reference-key-not-unique`     |
| `packages/relate/src/analytics/render.ts`                       | modified | Shared rendering of reference CTEs and guards                       |
| `connectors/duckdb`, `connectors/sqlite`, `connectors/postgres` | modified | Plan generation and physical checks for reference resources         |
| `packages/runtime/src/discovery/index.ts`, protocol             | modified | Reference datasets in `GraphDescription`                            |
| `tests/support/analytical-*-contract.ts`, `sql-corpus/`         | modified | Accepted and rejected join corpus; guard semantics per backend      |
| `specs/2026-10-18-analytical-properties.md`                     | modified | Amend the "no joins" rule when this lands                           |
| `apps/docs/content/authoring/datasets.md`                       | modified | "Reference datasets" section                                        |

## Done when

1. Key validation and every row of the validation table have compile or
   preparation tests, with diagnostics pointing at the SQL span.
2. Rows from the SQL corpus give the same values and guard outcomes on DuckDB,
   SQLite and Postgres.
3. Missing rows and key violations make the value unavailable with the right
   reason. A test proves the sum is never silently smaller.
4. Unreadable reference columns are reported exactly like unreadable base
   columns. Discovery hides invisible reference datasets and columns.
5. Evidence lists base and reference inputs with their own read times.
6. `pnpm check` (or `pnpm test:unit` without a test database, reported as such)
   and `pnpm check:boundaries`.

## Open questions

| Question                                                    | Lean                                                 |
| ----------------------------------------------------------- | ---------------------------------------------------- |
| Add a `date` logical type, or use ISO strings for v1?       | Add it (option A)                                    |
| `datasets.<Name>` or another SQL namespace?                 | `datasets.<Name>`: reserved, mirrors the registry    |
| As-of joins in v1?                                          | No; require filled calendars and revisit with demand |
| Allow `JOIN` spelled as inner join, given lookup semantics? | Yes, both spellings; documented in discovery         |
