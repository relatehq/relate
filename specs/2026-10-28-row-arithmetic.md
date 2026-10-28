# 2026-10-28: Arithmetic inside aggregate arguments

| Part                                                                                                            | Status                                            |
| --------------------------------------------------------------------------------------------------------------- | ------------------------------------------------- |
| Row arithmetic for reference-dataset currency conversion                                                        | Agreed prerequisite                               |
| [Types and parameter inference](#literal-and-parameter-inference)                                               | Agreed on 2026-10-28                              |
| [Floating-point behavior](#floating-point-behavior) and [checked accumulation](#checked-aggregate-accumulation) | Agreed on 2026-10-28                              |
| [Backend strategy](#backend-strategy)                                                                           | Implementation direction; boundary tests required |
| Implementation                                                                                                  | Not implemented                                   |

## Problem and concepts

[Reference datasets](./2026-10-28-reference-datasets.md) need
`SUM(d.spendMicros * f.rate)`. Today aggregate arguments are single operands;
formulas can combine aggregate results but cannot multiply values within a row
(`packages/sql-parser/src/lower.ts:394`,
`packages/relate/src/analytics/sql.ts:77`). This feature also works without
joins.

| Term               | Meaning                                                                                              | Example                                          |
| ------------------ | ---------------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| Operand            | A typed column, ordinary object property, parameter or literal                                       | `d.clicks`, `self.currency`, `$scale`, `1.0`     |
| Row expression     | Arithmetic evaluated separately for each eligible row                                                | `d.spendMicros * f.rate`                         |
| Eligible row       | A row admitted by an aggregate's `WHERE` and `FILTER`, with valid dependencies and reference matches | October deliveries with exactly one FX rate      |
| Aggregate leaf     | One aggregate within the output formula                                                              | `SUM(...)` in `SUM(...) / SUM(...)`              |
| Accumulator        | Internal running state used to combine rows; it can be wider than the output type                    | Exact integer total before the final int64 check |
| Underflow          | A nonzero result is too small to survive float64 rounding                                            | `1e-300 * 1e-300` rounds to zero                 |
| Subnormal          | A representable float64 value smaller than the smallest normal value                                 | `5e-324` remains nonzero                         |
| Checked evaluation | A value plus an internal failure flag; later operations cannot hide an earlier failure               | Overflow followed by subtraction still fails     |

## Authoring and types

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

### Literal and parameter inference

Infer one logical type for each named parameter before decoding its supplied
value. Promotion belongs to an arithmetic operation; it does not rewrite the
parameter's type. A JSON value such as `0.5` must never select its own type.
These rules extend `packages/runtime/src/analytics/resolve.ts:357-434`:

1. Resolve column/property types and existing comparison constraints first.
   Conflicting comparison constraints remain a preparation error. A parameter
   fixed by a comparison keeps that type in every arithmetic use; numeric
   operands of different types may still be promoted by the operation.
2. Numeric literals inside row expressions use their spelling: integer tokens
   are int64; decimal/exponent tokens, including `1.0` and `1e0`, are float64.
   Keep existing contextual literal conversion in comparisons and aggregate
   fallbacks (`resolve.ts:119-153`). Quoted strings are not numeric row
   operands.
3. For a parameter without a comparison type, infer from the known type of its
   immediate sibling operand or subtree. Collect constraints from every row
   occurrence to a fixed point before committing types. Different candidate
   types for the same parameter are a preparation error, independent of
   traversal order. Do not propagate a parent's promoted result type down into
   children.
4. After row constraints settle, a still-untyped parameter also used in the
   outer formula receives the existing float64 default. Repeat propagation and
   conflict checks. A parameter already typed by a row context keeps that type
   in the outer formula, just as a comparison-typed parameter does today.
5. Reject remaining untyped parameters, nonnumeric arithmetic inputs and values
   that cannot be decoded as the inferred type. Preserve existing rejection of
   null parameters and NULL literals outside `IS NULL`; nullable columns still
   follow the null rules above. Declared calculations still reject parameters.

Assume `d.clicks: int64`, `d.small: int32` and `d.rate: float64`. Each row below
is an independent expression; omitted `FROM self.delivery AS d` is unchanged.

| Expression / additional constraint              | Parameter type | Consequence                                                              |
| ----------------------------------------------- | -------------- | ------------------------------------------------------------------------ |
| `SUM(d.clicks * $scale)`                        | int64          | `{ scale: 2 }` works; `{ scale: 0.5 }` fails preparation                 |
| `SUM(d.clicks * (1.0 * $scale))`                | float64        | `{ scale: 0.5 }` works                                                   |
| `SUM(d.clicks * $scale) + $scale`               | int64          | Outer use promotes the decoded integer to float64                        |
| `SUM(d.clicks / $scale)`                        | int64          | Division promotes both inputs to float64; the parameter remains int64    |
| `SUM(d.clicks * $scale) WHERE d.rate = $scale`  | float64        | The comparison fixes the parameter; multiplication promotes clicks       |
| `SUM(d.rate * $scale) WHERE d.small = $scale`   | int32          | Fractional scale fails despite the float64 multiplication result         |
| `SUM(d.clicks * $scale) + SUM(d.rate * $scale)` | Conflict       | No comparison fixes the type; int64 and float64 row constraints disagree |
| `SUM($a * $b)`                                  | Ambiguous      | Neither parameter has a typed neighbor; reject                           |
| `SUM(($a * $b) * 1.0)`                          | Ambiguous      | The parent float64 operand does not type either child parameter          |
| `SUM(d.clicks) * $scale`                        | float64        | Existing outer-formula default remains unchanged                         |

An explicit float literal requests promotion at its own node. For example,
`(d.clicks + 1) * 1.0` must still fail if the integer addition overflows; the
outer multiplication cannot retroactively turn that addition into float64.
Converting int64 to float64 may lose precision. This remains approximate
arithmetic, not exact decimal or monetary arithmetic.

### Floating-point behavior

Use binary64 (the float64 representation) with rounding to the nearest
representable value, choosing the even significand at an exact halfway point.
The significand is the integer carrying the value's significant binary digits.
Round at every row arithmetic node; do not fuse or reassociate nodes.

| Situation                                                       | Checked result                                             |
| --------------------------------------------------------------- | ---------------------------------------------------------- |
| Finite rounded result, including a subnormal                    | Return that value                                          |
| Nonzero exact result rounds to zero                             | Return zero, with no arithmetic failure                    |
| Exact cancellation                                              | Return zero, with no arithmetic failure                    |
| Result rounds to infinity, or an arithmetic input is non-finite | Null placeholder plus `arithmeticFailed`                   |
| Division by positive or negative zero with non-null inputs      | Null placeholder plus `arithmeticFailed`                   |
| Null input                                                      | Follow child-failure precedence and null propagation above |

Normalize signed zero at the public value boundary as today
(`packages/relate/src/analytics/values.ts:170`). Underflow followed by division
can therefore fail at the division node: `1.0 / (1e-300 * 1e-300)` has a zero
denominator. Underflow must not hide an earlier child failure.

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
  Arithmetic range errors covered by this contract must be converted to checks
  before a backend can throw. Unrelated backend statement failures, including
  cancellation and resource errors, keep their existing wider failure scope.
- Existing arithmetic **between aggregates** keeps its current contract,
  including null for division by zero
  (`packages/relate/src/analytics/render.ts:169`). Document the distinction: a
  null final ratio is visible, whereas silently skipping a bad row inside `SUM`
  changes the numerator.

### Checked aggregate accumulation

Row-node checks and accumulation checks have different boundaries. Every integer
row node must fit int64 immediately. An aggregate accumulator may exceed int64
while combining valid rows; check the final result against its output type. Do
not make success depend on the backend's row order or partial aggregation.

| Aggregate           | Accumulation and finalization                                                                                                          |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| Integer `SUM`       | Accumulate exactly in a wider representation; only the final total must fit int64                                                      |
| Integer `AVG`       | Accumulate an exact total and count, divide before converting to float64; the total need not fit int64                                 |
| Float `SUM` / `AVG` | Use overflow-safe widened accumulation of the already-rounded row values; for AVG divide by count before the final float64 range check |
| `MIN` / `MAX`       | Select among valid non-null values, but retain failures from every eligible row                                                        |
| `COUNT`             | Count non-null values (or rows for `*`), check the final int64 range, and retain failures even from null placeholders                  |

Float aggregates retain approximate numeric results; ordinary last-bit rounding
variation is allowed. Their range checks must distinguish a genuinely
out-of-range final result from a temporary accumulator overflow. Use an exact
wide range check if the approximate accumulator cannot establish that
distinction. The parity corpus specifies numeric tolerances for approximate
results and exact agreement for availability, nulls and failure flags.

Every accumulation or final conversion failure sets the same per-cell
`arithmeticFailed` check. Empty/all-null aggregate behavior and result types
remain unchanged. Checks run before outer fallbacks or formula projection.

This also applies to existing plain numeric aggregate leaves, such as `SUM(x)`
and `AVG(x)`, including leaves inside an outer formula. Otherwise `SUM(x)` and
`SUM(x + 0)` would have different overflow isolation, and batching an old field
with a new one could still abort both. This deliberately replaces current
statement-level integer aggregate overflow handling
(`connectors/sqlite/test/analytics.test.ts:433`,
`connectors/postgres/src/plan.ts:74`, `connectors/duckdb/src/plan.ts:55`).
Arithmetic operators between aggregate results keep their existing contract;
only their aggregate inputs gain checked accumulation.

Required examples, with `M = 9223372036854775807` and all rows eligible:

| Expression and rows                                          | Expected outcome                                                |
| ------------------------------------------------------------ | --------------------------------------------------------------- |
| `SUM(x + 0)` or `SUM(x)`, integers `[M, 1, -1]` in any order | Available, exact `M`                                            |
| `SUM(x + 0)` or `SUM(x)`, integers `[M, 1]`                  | Only that cell is unavailable with `execution-failed`           |
| `SUM((x + 1) - 1)`, integer `[M]`                            | Failure at the inner row addition despite cancellation          |
| `AVG(x + 0)` or `AVG(x)`, integers `[M, M]`                  | Available float64 approximation of `M`                          |
| `AVG(x * 1.0)` or `AVG(x)`, floats `[1e308, 1e308]`          | Available, approximately `1e308`                                |
| `SUM(x * 1.0)` or `SUM(x)`, floats `[1e308, 1e308]`          | Per-cell arithmetic failure                                     |
| `SUM(x)`, floats `[1e308, 1e308, -1e308]` in any order       | Available, approximately `1e308`; no temporary-overflow failure |

### Backend strategy

Native operators alone cannot implement the contract. SQLite promotes row
integer overflow to floating point and truncates integer division
([SQLite expressions](https://www.sqlite.org/lang_expr.html)); its native
integer SUM can throw before later rows cancel the excess
([SQLite aggregates](https://www.sqlite.org/lang_aggfunc.html)). PostgreSQL
float operations can throw on overflow or underflow before a post-operation
finite check runs
([PostgreSQL numeric types](https://www.postgresql.org/docs/current/datatype-numeric.html#DATATYPE-FLOAT)).

| Backend    | Row integers                                                            | Float row operations                                                       | Aggregation                                                                                            |
| ---------- | ----------------------------------------------------------------------- | -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| PostgreSQL | Widen to `numeric`, check each node, then narrow valid results          | Classify range before native execution using the guard below               | Widen integer totals to `numeric`; use guarded widened float accumulation and guarded final conversion |
| DuckDB     | Widen to `HUGEINT`, check each node, then narrow valid results          | Explicit float64 promotion; detect non-finite values and zero denominators | Widen integer totals; use overflow-safe float accumulation rather than an unguarded native SUM/AVG     |
| SQLite     | Connector-owned deterministic helpers with BigInt inputs and operations | Connector-owned checked helpers using binary64 operations                  | Connector-owned aggregates with exact BigInt integer state and widened float state                     |

A widened integer accumulator must accommodate the supported row count.
`HUGEINT` is sufficient for int64 inputs with a count bounded by int64; check
the count as well. Widening integers does not solve float accumulation. A float
implementation may accumulate significands grouped by binary exponent, combining
those groups in a wider representation before final conversion. Neither a native
float SUM that overflows early nor casting an already-overflowed result
satisfies this contract.

#### PostgreSQL guard

Use generated read-only SQL, without installing database functions or
extensions:

1. Decode finite float64 operands to exact signed integer significands and
   binary exponents using `pg_catalog.float8send` and `pg_catalog.get_byte`.
   Represent them as integer numerator/denominator pairs in `numeric`. An
   ordinary float-to-numeric cast or decimal text approximation is not an exact
   boundary classifier.
2. Compute the mathematical operation's numerator and denominator with wide
   integer operations. For division, check zero first. Compare integers by
   cross-multiplication, avoiding a rounded decimal division in the guard.
3. Classify against binary64 rounding boundaries, including the halfway point
   above the largest finite value and half the smallest positive subnormal.
   Overflow produces a failure; a result rounding to zero produces zero.
   Preserve nonzero subnormals.
4. Put the native float operation only in the safe branch of a generated `CASE`.
   Supply harmless operands to that operation outside its safe branch as an
   additional defense against evaluation during planning. Apply child failures,
   nulls, row eligibility and validity masks before returning a value/check.

This is an implementation algorithm, not an existing helper API. It keeps range
classification exact while retaining native binary64 rounding for safe results.
Use the same guarded conversion principle after widened aggregation. Qualify
built-in functions/operators as the current PostgreSQL dialect does
(`connectors/postgres/src/plan.ts:41-79`). Helpers remain generated-plan
internals, never caller SQL functions.

The first implementation slice must prove this strategy with parameterized,
constant, nested and excluded-row cases on all supported backends, including
PostgreSQL prepared plans. Cover adjacent representable values around overflow,
subnormal and round-to-zero boundaries, with unrelated fields in the same
statement. Do this before integrating the grammar and runtime so backend
limitations are discovered early. Equivalent helper implementations are allowed;
backend parity and per-cell isolation are release conditions.

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
   literals, every inference-table case (including reversed occurrence order),
   rejected nonnumeric operands and distinct arguments.
2. All three backends agree on `3 / 2 = 1.5`, integer limits, intermediate
   overflow followed by cancellation, multiplication overflow, float overflow,
   zero division, nulls and propagation of earlier failures. Include underflow
   to zero, preserved subnormals, rounding-boundary neighbors and a subsequent
   division by an underflowed zero.
3. Every accumulation-table example passes on all three backends, including
   reordered rows, plain aggregates, outer formulas and healthy sibling cells.
   Check exact integer results and failure flags; use explicit tolerances for
   approximate float aggregates. PostgreSQL arithmetic errors cannot escape the
   generated guards.
4. A bad row cannot disappear inside `SUM`, `AVG`, `MIN`, `MAX`, `COUNT` or a
   formula with multiple leaves. Outer fallback cannot hide a failure.
5. Excluded rows and failed reference matches do not introduce arithmetic
   failures. One bad cell leaves unrelated fields and object slots available.
6. Parameter budgets, authorization footprints, validity masks and backend
   cancellation still hold. Generated helpers are inaccessible to caller SQL.
7. Update package/public documentation and run the owning tests, boundary checks
   and repository validation appropriate to the implementation.
