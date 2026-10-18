# 2026-10-18: Analytical properties spike report

**Status:** exploratory implementation, not the feature. Based on the
[revised proposal](./2026-10-18-analytical-properties.md) at `9858435`.
Executable work lives in
[`dev/analytical-properties`](../dev/analytical-properties/README.md). No public
package exports or application behaviour change.

The caller expression API is workable. Keep libpg_query, inject its adapter at
Node composition, put policy and candidate orchestration in a new runtime
`analytics` module, and put SQL generation in the connectors. Before building
the feature, resolve SQLite cancellation, exact decimals and statement failure
granularity. The proposed batching SQL also needs to group by object slot when
expressions use `self` properties.

## What the experiments establish

| Experiment                   | Executable evidence                                  | Result                                                                                                                                                                              |
| ---------------------------- | ---------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Caller API typing            | `test/api.typecheck.ts`, root TypeScript check       | Literal compute aliases remain optional JSON scalars; selected properties keep their types; collisions, unknown order/filter aliases and mistyped ordinary filters fail compilation |
| Parsing and resolution       | `test/parser.test.ts`, `test/corpus.ts`              | libpg_query lowers into a Relate-owned representation; unsupported nodes fail closed; named parameters need a lexical adapter; PG folds unquoted names                              |
| Backend parity               | `test/parity.ts`, run separately for SQLite/Postgres | Same corpus covers COUNT variants, SUM/MIN/AVG int64, exact large values, dates, self properties, empty input, composite keys and injection/scope cases                             |
| Runtime seam                 | `test/runtime.test.ts`                               | Hidden associations reject before execution; forbidden inputs are omitted; absent correlation cannot become an unscoped query; required aliases fail the whole query                |
| Scope and paging             | parity/runtime tests and benchmark                   | Filter/order operate on all candidates before paging; numeric int64 ordering, nulls last, ID ties and unchanged-data continuations work; scope limit+1 runs no SQL                  |
| Cancellation and concurrency | parity/queue tests, supervised thread probe          | PG host timeout and caller cancellation work; SQLite needs process termination on the tested Node build; queue full, wait expiry and queued abort release resources correctly       |
| Ownership                    | `test/architecture.test.ts`                          | Runtime cannot import the parser or SQL generator; portable contracts cannot import drivers; adapters own those dependencies                                                        |

The corpus is deliberately smaller than the proposal's complete v1 corpus. Its
accepted and rejected examples describe **this spike**, not final SQL support.
Package tests do not depend on this directory or its fixtures.

## API shape and its limits

The [type probe](../dev/analytical-properties/api.ts) extends the existing
public `ObjectResult`, `ReadOptions`, `QueryOptions` and `QueryResult`
contracts:

```ts
const page = await customers.query({
  select: ['name'],
  compute: {
    loginsOct: {
      sql: `SELECT COUNT(*) FROM self.events e
            WHERE e.eventType = 'login' AND e.occurredAt >= $since`,
      parameters: { since: '2026-10-01T00:00:00Z' },
    },
  },
  where: { name: { eq: 'Acme' }, loginsOct: { gt: '0' } },
  orderBy: [{ field: 'loginsOct', direction: 'desc' }],
});
// name keeps its ordinary property type.
// loginsOct: string | number | boolean | null | undefined
// Undefined is necessary: forbidden/unavailable fields are omitted.
```

`NoInfer<C>` on computed filter/order keys prevents a typo in `orderBy` from
silently becoming another inferred compute alias. TypeScript cannot infer a
logical result type from arbitrary SQL text; `meta.computed` remains necessary.
Runtime validation is still required for JavaScript, widened records and remote
JSON. This is a compile-only API experiment, not implemented `get`/`query`
methods. It does not yet preserve the existing evidence-mode generic in all
cases, nor implement `decodeComputed`.

The executable runtime seam accepts actor-filtered association metadata and
already-authorized candidate values. It produces computed values, per-field
statuses and type metadata. It does **not** implement graph authoring,
`defineDataset`, compiler policies, stable IDs or the public response envelope.
Its status fields are intentionally a small experiment, not a replacement for
protocol `FieldEvidence` or `ReadError`.

## Findings that change implementation choices

### 1. Keep the WASM parser, but its grammar is not the whole API

[Recorded measurements](../dev/analytical-properties/evidence/measurements.json):
`libpg-query@18.1.5`, grammar version `180004`, WASM **1,717,872 bytes**, import
**6.39 ms**, first parse **9.48 ms**, warm parse p50 **0.0143 ms** and p95
**0.0230 ms** across 1,000 iterations. These are one fresh Node process on a
local macOS ARM64 machine, not browser bundle measurements or service latency.
The npm registry reported **1,826,017 unpacked package bytes**. The measurement
file includes the WASM and spec SHA-256 hashes and exact platform versions.
These results do not justify writing a replacement parser. The injected spike
parser is asynchronous; Node composition should initialize WASM once before
serving requests, or the final parser contract must explicitly return a Promise.

Raw PostgreSQL grammar rejects `$since`; it accepts positional `$1`. The spike
lexes named parameters before parsing and preserves single/double quotes,
dollar-quoted strings, line comments and nested block comments. It rejects
caller positional parameters to prevent collisions. The adapter lowers the AST
into [`SqlQuery`](../dev/analytical-properties/contracts.ts); every consumed
node has an explicit key allowlist. Original SQL is never sent to a database.

PG folds `e.eventType` to `e.eventtype`. The experiment resolves folded names
back to model names and accepts the exact quoted `e."eventType"`. Declarations
that collide after folding are rejected. Recommendation: expose a folded SQL
namespace, keep original names in discovery, allow exact quoted model names, and
pin these rules with corpus cases. Quoted lowercase names also resolve in the
folded namespace in this spike; decide explicitly whether final semantics should
instead follow stricter PostgreSQL quoting rules.

All casts and caller `COALESCE` are explicitly rejected in this spike, together
with joins, subqueries, grouping, windows, multiple statements, output aliases,
`ONLY`, aggregate FILTER and qualified/UDF functions. This is a tested subset,
not a finding that the proposed casts/COALESCE are infeasible. Escape strings,
Unicode identifier escapes, location remapping and the final cast allowlist
remain work for the parser package. The parameter rewrite changes offsets, so
original-source SQL diagnostics require a source map.

Generated constants also need explicit types. PostgreSQL can infer two otherwise
unconstrained parameters as text: rewriting `2 < 10` to an untyped `$1 < $2`
changes its result. The spike carries inferred literal types through the
representation and binds them with casts; both backends test this case.

### 2. Batch by object slot when self properties participate

The proposal's group-by-correlation-key plan cannot distinguish two objects with
the same external key but different `customerSince`. The tested plan is:

```sql
WITH keys(slot, p0, p1) AS (
  VALUES (0, $1::text, $2::timestamptz),
         (1, $3::text, $4::timestamptz)
), agg AS (
  SELECT k.slot,
         COUNT(*) FILTER (WHERE e.occurred_at >= k.p1) AS v0
  FROM keys k
  JOIN "events" e ON e.customer_id = k.p0
  GROUP BY k.slot
)
SELECT k.slot, COALESCE(a.v0, 0) AS v0
FROM keys k LEFT JOIN agg a ON a.slot = k.slot
ORDER BY k.slot;
```

Inner joining real events before aggregation prevents a phantom COUNT row for
empty input. The final left join yields zero for COUNT and null for other
aggregates. A test with duplicate Acme keys and different dates returns **2**
and **1**, rather than sharing one answer. Correlation is outside caller
predicates, including `OR 1 = 1`. Values are bound and physical names quoted.

Multiple aliases with different WHERE clauses share one healthy statement. When
only some objects lack a self dependency, this spike partitions by the available
alias set; an unrelated count still succeeds. That can exceed the proposal's
one-statement rule. Production should either permit exceptional partitions or
carry per-alias validity masks in one keys relation. Do not silently drop all
aliases because one dependency is missing.

[SQLite's plan](../dev/analytical-properties/evidence/sqlite-plan.json) uses the
correlation index.
[Postgres's plan](../dev/analytical-properties/evidence/postgres-plan.json)
chooses a hash join with a sequential event scan in this dataset. One generated
statement is not a promise of one physical scan or index strategy.

### 3. SQLite worker termination is not a cancellation guarantee

On **Node 26.9.0 / SQLite 3.53.4**, `DatabaseSync` has no `setProgressHandler`.
More importantly, `Worker.terminate()` did not settle while a long native SQLite
statement was running. Both original cancellation tests hit the **15,000 ms**
test timeout. The retained
[supervised reproduction](../dev/analytical-properties/probes/worker-termination.mjs)
confirms termination still has not completed after **500 ms**, then its parent
kills the probe process so no query is left running.

The working experiment uses a read-only SQLite **child process**, sends BigInts
over advanced IPC, and kills and awaits the child on timeout/abort. Tests verify
bounded return and a successful subsequent query. The queue slot is released
only after the process exits. Production options are a process pool or a SQLite
driver with a verified native interrupt API. Do not ship the spec's
progress-handler/thread fallback without proving it on every supported Node
line. This run does not establish behaviour on Node 22 or 24.

Postgres uses `BEGIN READ ONLY`, local `statement_timeout`, and a separate
control connection calling `pg_cancel_backend` on caller abort. The disposable
statement client is then destroyed; a late cancel cannot hit its next query.
This is an experiment, **not** the proposed protocol CancelRequest or a pooled
connector. Cancellation under a lost network/control connection and safe pooled
client reuse need further work. Statement connection startup has a separate
bound from the SQL execution timeout.

### 4. Decimal AVG needs an exact portable implementation or narrower scope

The Postgres experiment returns:

```sql
AVG(x)  -- x = numeric(10,2): 1.00, 2.00, 2.00
-- '1.6666666666666667', not the proposed scale-6 '1.666667'
ROUND(1.2345645::numeric, 6)
-- '1.234565', whereas half-even requires '1.234564'
```

Casting to a fixed-scale numeric alone does not supply half-even rounding.
SQLite has no native exact decimal aggregate in this spike. Do not claim
cross-backend decimal parity from passing int64 tests. Prefer an exact sum/count
plus shared decimal rounding design, with precision/overflow tests, or
explicitly defer decimal aggregates. The `decimal(...)` authoring helper name
remains undecided because the backing representation is not settled.

Int64 SUM/COUNT use strings across both drivers and reject overflow/rounded
results. Integer AVG is explicitly cast to float64 on Postgres, matching SQLite
in the shared corpus; this is not a proof of bit-identical floating arithmetic
for all inputs. Timestamps here support milliseconds only.

### 5. One failing SQL statement cannot isolate an alias

Returned-value validation can omit one alias across a page while preserving
another. A late batch's invalid result/failure also invalidates that alias's
earlier successful values. Required aliases fail the query even when
`requireComplete` is absent.

A database error, such as aggregate overflow, aborts the entire statement. Every
alias sharing it is unavailable. Recommendation: state this explicitly in the
spec. Strict alias-level execution isolation would require separate statements
or bounded retries, changing the batching and work-budget contract. Dependency
failures stay per object. The spike sanitizes backend failures; SQL, parameter
values and driver errors are absent from returned field evidence.

### 6. Keep a per-query scope cap and a shared connection queue

The benchmark seeds **100,000 synthetic events / 10,000 customers**, with an
index on the correlation key, then returns a 25-object computed-order page:

| Backend  | Candidates | Statements |          Observed elapsed |
| -------- | ---------: | ---------: | ------------------------: |
| SQLite   |      1,000 |          1 |                   78.5 ms |
| SQLite   |     10,000 |         10 |                  380.4 ms |
| Postgres |      1,000 |          1 |                   46.9 ms |
| Postgres |     10,000 |         10 |                  281.2 ms |
| Both     |     10,001 |          0 | rejected before execution |

These single samples include disposable connection/process overhead. They are
not a capacity or production latency claim; memory, concurrent actors and
high-cardinality duplicate keys were not profiled. Source, plans, generated SQL
and raw measurements are retained and the command is reproducible.

Retain 10,000 as a **host-configured per-query** candidate cap, applied after
object policy and ordinary property filters. Share the 4-active/32-waiting queue
across resources and actors on each configured connection. A caller must not
obtain another budget simply by creating a new binding. Add fairness or
per-actor admission only after workload tests; this spike does not measure it.
The available evidence does not justify computed-filter pushdown yet.

Also bound **parameter count**, not only keys per statement: many `self`
properties multiply key bindings and can exceed backend parameter ceilings.
`readAt` should be captured inside backend execution after queue admission; the
spike's evidence currently captures it before admission and is explicitly not
the final evidence contract.

## Recommended ownership and integration

| Spike module                                                         | Future owner                                                | Boundary                                                                                                                         |
| -------------------------------------------------------------------- | ----------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `api.ts`, portable logical types/SQL representation and input codecs | `packages/relate`                                           | Portable authoring/compiler types and typed consumer facade; no parser/driver imports                                            |
| Expression JSON, computed descriptors/evidence/errors                | `packages/protocol`                                         | Transport-safe contracts; no SQL semantics                                                                                       |
| `parser.ts`                                                          | New `packages/sql-parser` (`@relate/sql-parser`, suggested) | Sole libpg_query dependency and AST knowledge; returns Relate representation                                                     |
| `resolve.ts`, `runtime.ts`, `queue.ts`                               | New `packages/runtime/src/analytics/`                       | Name/type/policy resolution, dependency collection, limits, batching, required aliases, computed candidate ordering and evidence |
| `generate.ts`, provider execution in `backends.ts`                   | `connectors/sqlite`, new `connectors/postgres`              | Plan authorized expressions, execute exact SQL, report/validate physical types and own cancellation                              |
| Composition currently in tests/benchmark                             | `packages/node`                                             | Inject parser/backends; own one queue per configured connection, schema checks, reload and disposal                              |
| Shared SQL corpus                                                    | `packages/relate/test/sql-corpus/`                          | Final portable conformance corpus; backend tests consume cases without importing examples/dev fixtures                           |

Do not put the analytical Postgres implementation in `packages/postgres`: that
package owns Relate persistence, not application datasets. Keep the bind rename
and observation-scope migration separate as proposed.

The checked runtime dependency graph currently permits `queries` to depend on
`reads`, `authorization`, `storage` and activity types. Add an explicit
`analytics` owner and public module entry; permit composition/queries to call
it. Avoid analytics importing the whole query implementation or source resolver.
Inject the authorized dependency-read callback. The prototype already enforces
parser injection and backend-owned planning in its architecture test.

Concrete integration points discovered in the checkout:

- `packages/runtime/src/runtime.ts:readObject` currently dispatches native or
  source reads. Reuse it to obtain self dependencies, then run analytics and the
  final authorization check; do not add a second policy evaluator.
- `packages/runtime/src/queries/query.ts:createGraphQuery` currently stops at
  100 scanned candidates, fills the page, and rechecks authorization/freshness
  before projection. Computed ordering needs a separate full-candidate path;
  adding aggregation after today's page selection would give incorrect pages.
- `packages/runtime/src/reads/cursors.ts:cursorCodec` already provides
  encrypted, authenticated, expiring scope-bound cursors. Reuse it for
  `(values, id)` with compute/parameter/binding/principal scope. The spike's
  plain `after` object is an internal seam, **not** safe for a public cursor.
- `packages/protocol/src/index.ts` aliases `QueryRequest = TraversalRequest`,
  and traversal extends `ReadRequest`. Adding compute directly to shared read
  options would accidentally expose it on traversal. Split common read controls
  from object read/query extensions first.

## Deliberately not implemented

No dataset declarations, association compiler, bind rename/migration, schema
introspection, real object authorization/adoption, final policy/freshness
rechecks, reload retirement, snapshot semantics, cache, connection pool,
decoder, discovery, HTTP/MCP, Inspector or activity integration. No full
compact/full protocol evidence; no `modifiedAt`, dependency evidence or stable
binding revision. No complete JSON input validator, SQL diagnostics/source map,
cast set, COALESCE, boolean/int32/decimal/microsecond type support, computed
filter operators beyond `eq`/`gt`, or ordinary object filters inside the
prototype. Those are not silently considered passed. The public caller type
probe is separate from the executable orchestration seam.

## Validation and next steps

Run instructions and scope are in the
[spike README](../dev/analytical-properties/README.md). The focused suites run
real SQLite and Postgres queries; the caller API probe runs under the repository
TypeScript check. Full repository validation is recorded in the PR.

Before the feature implementation:

1. Agree the cancellation approach, statement failure granularity, decimal
   scope, identifier semantics and cast allowlist using these findings.
2. Land the separately scoped `bind`/observation migration and protocol split.
3. Land portable dataset/association contracts, compiler validation and the
   complete shared corpus, including physical schema/type checks.
4. Implement one real public object-read path through the proposed modules,
   retaining final authorization/freshness checks and encrypted cursor scope.
5. Extend transport/discovery/evidence and only then update product status.

Parser package source:
[libpg-query](https://github.com/constructive-io/libpg-query-node). Driver
documentation: [Node SQLite](https://nodejs.org/api/sqlite.html),
[node-postgres client](https://node-postgres.com/apis/client). The conclusions
above are backed by the pinned local probes, not inferred solely from
documentation for a different Node version.
