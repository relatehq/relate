# Analytical properties spike

Executable experiments for the
[design](../../specs/2026-10-18-analytical-properties.md). This is not a public
Relate feature. Start with the
[report](../../specs/2026-10-18-analytical-properties-spike.md) for findings,
architecture, limitations and recommended next steps.

From the repository root, after `pnpm install`:

```sh
# Parser, runtime seam, SQLite, Postgres, queue and architecture tests.
# Requires the disposable RELATE_TEST_DATABASE_URL in this worktree's .env.
pnpm test:analytical

# No Postgres required:
pnpm exec vitest run --project unit dev/analytical-properties/test

# Includes the compile-only caller API probe:
pnpm exec tsc --noEmit -p tsconfig.tests.json

# Recreates synthetic tables, measures, and replaces evidence files.
pnpm exec dotenvx run -f .env -- node --import tsx dev/analytical-properties/benchmark.ts
```

The suites also participate in `pnpm check`. Each database test owns fresh data
and cleanup. The benchmark creates a uniquely named Postgres table in the test
database and a temporary SQLite file; it drops/removes both in `finally`. Do not
use a production database for these development commands.

The executable composition seam is:

```ts
const read = createAnalyticalSpike(
  backend, // plan + execute; owns SQL generation and drivers
  visibleAssociation, // undefined when hidden from this actor
  parseExpression, // injected WASM parser adapter
  { queue: connectionQueue, batchSize: 1000, scopeLimit: 10_000 },
);

await read(authorizedCandidates, {
  compute: {
    count: { sql: 'SELECT COUNT(*) FROM self.events' },
  },
  where: { count: { eq: '0' } },
  orderBy: [{ field: 'count', direction: 'desc' }],
  limit: 20,
});
```

`authorizedCandidates` is an explicit test seam, not authorization by itself.
Production would derive and recheck it through Relate's existing object read and
policy machinery. The internal `after: { values, id }` is not a wire-safe
cursor. `api.ts` separately tests the proposed **types** of the public caller
surface without pretending those methods exist today.

No package imports this directory. The only added dependency is the root
**devDependency** `libpg-query@18.1.5`. No package exports, persistence, public
docs, example applications or product status claims change.
