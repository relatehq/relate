# 2026-10-28: Arithmetic inside aggregate arguments

| Part                                                         | Status                |
| ------------------------------------------------------------ | --------------------- |
| Row arithmetic for reference-dataset currency conversion     | Proposed prerequisite |
| Types, checked evaluation and per-field failure checks below | Proposed after review |
| Implementation                                               | Not implemented       |

## Problem and concepts

[Reference datasets](./2026-10-28-reference-datasets.md) need
`SUM(d.spendMicros * f.rate)`. Today aggregate arguments are single operands;
formulas can combine aggregate results but cannot multiply values within a row
(`packages/sql-parser/src/lower.ts:394`,
`packages/relate/src/analytics/sql.ts:77`). This feature also works without
joins.

| Term               | Meaning                                                                                              | Example                                      |
| ------------------ | ---------------------------------------------------------------------------------------------------- | -------------------------------------------- |
| Operand            | A typed column, ordinary object property, parameter or literal                                       | `d.clicks`, `self.currency`, `$scale`, `1.0` |
| Row expression     | Arithmetic evaluated separately for each eligible row                                                | `d.spendMicros * f.rate`                     |
| Eligible row       | A row admitted by an aggregate's `WHERE` and `FILTER`, with valid dependencies and reference matches | October deliveries with exactly one FX rate  |
| Aggregate leaf     | One aggregate within the output formula                                                              | `SUM(...)` in `SUM(...) / SUM(...)`          |
| Checked evaluation | A value plus an internal failure flag; later operations cannot hide an earlier failure               | Overflow followed by subtraction still fails |

## Proposed authoring and types

No new consumer option is needed. Existing `compute` and `computed` accept the
extended SQL grammar once this feature lands:

```ts
await relate.PlanLine.query({
  compute: {
    scaledClicks: {
      sql: 'SELECT SUM(d.clicks * 1.0) FROM self.delivery AS d',
    },
  },
});
```

Proposed replacement for `SqlAggregate.argument` and the corresponding resolved
argument (`packages/relate/src/analytics/query.ts:60`):

```ts
type RowExpression<O> =
  | O
  | {
      readonly kind: 'arithmetic';
      readonly op: '+' | '-' | '*' | '/';
      readonly left: RowExpression<O>;
      readonly right: RowExpression<O>;
    };
// Parser: argument: RowExpression<Operand> | '*'
// Resolved plan: argument: RowExpression<ResolvedOperand> | '*'
```

Every resolved arithmetic node also carries its inferred logical type and
nullability. Preserve source spans for operand and operator diagnostics. Plain
operands retain their existing types; only arithmetic operands must be numeric.
Nested aggregates, casts, arbitrary functions, row-level `COALESCE`/`NULLIF`,
and arithmetic predicates remain outside this addition. `COUNT(DISTINCT ...)`
continues to accept only a plain operand. Parentheses obey ordinary precedence.

| Operands                                         | Result and evaluation                                                                       |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------- |
| int32/int64 `+`, `-`, `*` int32/int64            | Exact int64; check the result of every node against the signed 64-bit range                 |
| Either operand float64                           | Convert both operands to float64 before the operation; finite result required               |
| Numeric `/` numeric                              | Convert both operands to float64 **before** division; zero denominator fails                |
| Null operand                                     | Null value, unless a child expression already failed; aggregate null rules remain unchanged |
| String, boolean, date or timestamp in arithmetic | Preparation error                                                                           |

Literal and parameter resolution must retain the existing contextual typing
rules (`packages/runtime/src/analytics/resolve.ts:76` and `:119`), extended to
numeric nodes. Reject ambiguous or conflicting parameter types rather than
letting a backend coerce them. An explicit float literal such as `1.0` requests
float64 promotion. Converting int64 to float64 may lose precision; this is an
approximate operation, not exact decimal or monetary arithmetic.

## Checked execution

```mermaid
flowchart LR
  A[Resolve numeric operands and node types] --> B[Select eligible rows]
  B --> C[Evaluate each node with failure propagation]
  C --> D[Aggregate safe values and combine failure flags]
  D --> E[Return one value and check per object field]
```

- Evaluate only rows admitted by the leaf predicate and validity mask. With
  reference joins, also require exactly one reference match. Failed lookup rows
  contribute lookup checks, not arbitrary representative arithmetic.
- At every node, retain child failures; then apply null propagation; then
  evaluate the operation with its type-specific checks. An invalid operation
  yields an internal null placeholder plus a failure flag. It must not throw
  across unrelated cells or become an ordinary nullable value.
- OR failures across all eligible rows and aggregate leaves of the output field.
  Return `SlotRow.checks[i].arithmeticFailed` as specified in the
  [connector result contract](./2026-10-28-reference-datasets.md#batching-and-connector-output).
  This check is also required for expressions without reference joins.
- Runtime withdraws that field on that object with `execution-failed`. Neither
  an aggregate ignoring nulls nor an outer `COALESCE` may erase the failure.
  Actual backend statement failures keep their existing wider failure scope.
- Existing arithmetic **between aggregates** keeps its current contract,
  including null for division by zero
  (`packages/relate/src/analytics/render.ts:169`). Document the distinction: a
  null final ratio is visible, whereas silently skipping a bad row inside `SUM`
  changes the numerator.

Native operators alone cannot implement the integer contract. SQLite promotes
integer overflow to floating point and truncates integer division
([SQLite expressions](https://www.sqlite.org/lang_expr.html)). For example,
`(9223372036854775807 + 1) - 9223372036854775807` produces `0.0`; the final
in-range value cannot reveal the overflow.

Proposed backend strategy: widen int64 operands before integer operations in
Postgres (`numeric`) and DuckDB (`HUGEINT`), range-check each node, then narrow
only valid results. SQLite uses connector-owned deterministic checked helpers
with BigInt inputs/operations; JavaScript number arithmetic is insufficient.
These helpers are generated-plan internals, never caller SQL functions. Float
operations explicitly promote operands and detect zero division and non-finite
results at each node. Final aggregate overflow checks remain necessary too.

The exact helper SQL is an implementation choice, but backend parity is a
release condition. Do not silently weaken the contract on one connector.

## Files and ownership

| File                                                                   | Change   | Why                                                              |
| ---------------------------------------------------------------------- | -------- | ---------------------------------------------------------------- |
| `packages/relate/src/analytics/sql.ts`, `query.ts`                     | modified | Row-expression types and resolved result metadata                |
| `packages/sql-parser/src/lower.ts`                                     | modified | Arithmetic arguments and diagnostics                             |
| `packages/runtime/src/analytics/resolve.ts`, `batch.ts`                | modified | Type inference, authorization traversal and dependency remapping |
| `packages/relate/src/analytics/render.ts`, `query-validation.ts`       | modified | Checked node rendering and complete parameter budgets            |
| `packages/relate/src/analytics/connectors.ts`                          | modified | Per-cell checks shared with reference datasets                   |
| `connectors/duckdb`, `connectors/sqlite`, `connectors/postgres`        | modified | Checked operators/helpers and decoded checks                     |
| `packages/runtime/src/analytics/merge.ts`                              | modified | Per-cell arithmetic failure handling                             |
| `tests/support`, `packages/sql-parser/test`                            | modified | Portable accepted/rejected corpus and arithmetic contracts       |
| Owning package contracts and `apps/docs/content/authoring/datasets.md` | modified | Authoring, approximate numeric results and failure semantics     |

## Done when

1. Parser and type tests cover nesting, precedence, mixed numeric types,
   literals, parameters, rejected nonnumeric operands and distinct arguments.
2. All three backends agree on `3 / 2 = 1.5`, integer limits, intermediate
   overflow followed by cancellation, multiplication overflow, float overflow,
   zero division, nulls and propagation of earlier failures.
3. A bad row cannot disappear inside `SUM`, `AVG`, `MIN`, `MAX`, `COUNT` or a
   formula with multiple leaves. Outer fallback cannot hide a failure.
4. Excluded rows and failed reference matches do not introduce arithmetic
   failures. One bad cell leaves unrelated fields and object slots available.
5. Parameter budgets, authorization footprints, validity masks and backend
   cancellation still hold. Generated helpers are inaccessible to caller SQL.
6. Update package/public documentation and run the owning tests, boundary checks
   and repository validation appropriate to the implementation.
