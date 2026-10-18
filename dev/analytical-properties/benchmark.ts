import { performance } from 'node:perf_hooks';
import {
  readFileSync,
  statSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir, platform, arch } from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { fork } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import pg from 'pg';
import { sqliteBackend, postgresBackend } from './backends.js';
import { createAnalyticalSpike } from './runtime.js';
import { quote } from './generate.js';
import type {
  Association,
  Backend,
  Candidate,
  Statement,
} from './contracts.js';

const started = performance.now();
const parser = await import('libpg-query');
const imported = performance.now();
const sql =
  "SELECT COUNT(*) FROM self.events e WHERE e.eventType = 'login' AND e.occurredAt >= $1";
const ast = await parser.parse(sql);
const initialized = performance.now();
const timings: number[] = [];

for (let i = 0; i < 1000; i++) {
  const start = performance.now();

  await parser.parse(sql);
  timings.push(performance.now() - start);
}

timings.sort((a, b) => a - b);
const require = createRequire(import.meta.url);
const parserDirectory = dirname(require.resolve('libpg-query/package.json'));
const wasm = join(parserDirectory, 'wasm/libpg-query.wasm');
const report: Record<string, unknown> = {
  at: new Date().toISOString(),
  node: process.version,
  platform: `${platform()}-${arch()}`,
  specSha256: createHash('sha256')
    .update(readFileSync('specs/2026-10-18-analytical-properties.md'))
    .digest('hex'),
  parser: {
    version: JSON.parse(
      readFileSync(join(parserDirectory, 'package.json'), 'utf8'),
    ).version,
    wasmBytes: statSync(wasm).size,
    wasmSha256: createHash('sha256').update(readFileSync(wasm)).digest('hex'),
    importMs: imported - started,
    firstParseMs: initialized - imported,
    warmIterations: timings.length,
    warmP50Ms: timings[500],
    warmP95Ms: timings[950],
  },
};
const { parseExpression } = await import('./parser.js');
const directory = mkdtempSync(join(tmpdir(), 'relate-analytical-bench-'));
const path = join(directory, 'events.db');
const sqlite = new DatabaseSync(path);

sqlite.exec(
  'CREATE TABLE events(customer_id TEXT NOT NULL, event_type TEXT NOT NULL, occurred_at TEXT NOT NULL)',
);
sqlite.exec(
  "WITH RECURSIVE n(x) AS (VALUES(0) UNION ALL SELECT x+1 FROM n WHERE x < 99999) INSERT INTO events SELECT 'customer_' || (x % 10000), 'login', '2026-10-02T00:00:00.000Z' FROM n",
);
sqlite.exec('CREATE INDEX events_customer ON events(customer_id)');
report.sqliteVersion = sqlite
  .prepare('SELECT sqlite_version() AS version')
  .get()!.version;
report.sqliteProgressHandler = 'setProgressHandler' in sqlite;
sqlite.close();

async function terminationProbe() {
  const child = fork(
    new URL('./probes/worker-termination.mjs', import.meta.url),
    [path],
    { execArgv: [], stdio: ['ignore', 'ignore', 'ignore', 'ipc'] },
  );
  const exited = new Promise<void>((resolve) =>
    child.once('exit', () => resolve()),
  );
  let timer: ReturnType<typeof setTimeout>;
  let deadline: ReturnType<typeof setTimeout>;
  const result = await new Promise<{ terminatedWithin500Ms: boolean }>(
    (resolve, reject) => {
      deadline = setTimeout(
        () => reject(new Error('worker probe failed to start')),
        3000,
      );
      child.on('error', reject);
      child.on('message', (message: any) => {
        if (message.terminating) {
          clearTimeout(deadline);
          timer = setTimeout(
            () => resolve({ terminatedWithin500Ms: false }),
            500,
          );
        }

        if (message.terminated) resolve({ terminatedWithin500Ms: true });
      });
    },
  ).finally(async () => {
    clearTimeout(timer);
    clearTimeout(deadline);
    child.kill('SIGKILL');
    await exited;
  });

  return result;
}

const client = new pg.Client({
  connectionString: process.env.RELATE_TEST_DATABASE_URL,
  connectionTimeoutMillis: 3000,
});
const table = `analytical_bench_${randomUUID().replaceAll('-', '')}`;
const samples: unknown[] = [];

try {
  report.workerTermination = await terminationProbe();

  if (!process.env.RELATE_TEST_DATABASE_URL)
    throw new Error('RELATE_TEST_DATABASE_URL required');

  await client.connect();
  report.postgresVersion = (
    await client.query('SELECT version() AS version')
  ).rows[0].version;
  await client.query(
    `CREATE TABLE ${quote(table)}(customer_id text NOT NULL, event_type text NOT NULL, occurred_at timestamptz NOT NULL)`,
  );
  await client.query(
    `INSERT INTO ${quote(table)} SELECT 'customer_' || (x % 10000), 'login', '2026-10-02T00:00:00Z'::timestamptz FROM generate_series(0, 99999) x`,
  );
  await client.query(`CREATE INDEX ON ${quote(table)}(customer_id)`);
  await client.query(`ANALYZE ${quote(table)}`);

  for (const backend of [
    sqliteBackend(path),
    postgresBackend(process.env.RELATE_TEST_DATABASE_URL!),
  ]) {
    const model: Association = {
      name: 'events',
      table: backend.dialect === 'sqlite' ? 'events' : table,
      columns: {
        customerId: { physical: 'customer_id', type: 'string', readable: true },
        eventType: { physical: 'event_type', type: 'string', readable: true },
        occurredAt: {
          physical: 'occurred_at',
          type: 'timestamp',
          readable: true,
        },
      },
      properties: { externalId: { type: 'string', readable: true } },
      on: { customerId: 'externalId' },
    };

    for (const size of [1000, 10_000, 10_001]) {
      const candidates: Candidate[] = Array.from({ length: size }, (_, i) => ({
        id: `object_${String(i).padStart(5, '0')}`,
        properties: { externalId: `customer_${i}` },
      }));
      let statements = 0;
      let first: Statement | undefined;
      const measured: Backend = {
        dialect: backend.dialect,
        plan: backend.plan,
        execute: async (statement, options) => {
          statements++;
          first ??= statement;

          return backend.execute(statement, options);
        },
      };
      const read = createAnalyticalSpike(measured, model, parseExpression);
      const start = performance.now();
      let result: unknown;

      try {
        const page = await read(candidates, {
          compute: {
            count: {
              sql: "SELECT COUNT(*) FROM self.events e WHERE e.eventType = 'login'",
            },
          },
          orderBy: [{ field: 'count', direction: 'desc' }],
          limit: 25,
        });

        if (
          page.data.length !== 25 ||
          page.data.some((r) => r.data.count !== '10')
        )
          throw new Error('benchmark produced incorrect counts');

        result = {
          returned: page.data.length,
          count: page.data[0]!.data.count,
        };
      } catch (error) {
        if (size !== 10_001) throw error;

        result = String(error);
      }

      samples.push({
        backend: backend.dialect,
        candidates: size,
        events: 100_000,
        elapsedMs: performance.now() - start,
        statements,
        result,
      });

      if (size === 1000 && first) {
        const plan = await backend.execute(
          {
            ...first,
            text: `${backend.dialect === 'postgres' ? 'EXPLAIN (FORMAT JSON)' : 'EXPLAIN QUERY PLAN'} ${first.text}`,
          },
          { signal: new AbortController().signal, timeoutMs: 5000 },
        );

        writeFileSync(
          new URL(`./evidence/${backend.dialect}-plan.json`, import.meta.url),
          JSON.stringify(
            plan,
            (_, value) =>
              typeof value === 'bigint' ? value.toString() : value,
            2,
          ) + '\n',
        );
        writeFileSync(
          new URL(
            `./evidence/${backend.dialect}-statement.sql`,
            import.meta.url,
          ),
          first.text + '\n',
        );
      }
    }
  }

  report.batchSamples = samples;
  writeFileSync(
    new URL('./evidence/parser-ast.json', import.meta.url),
    JSON.stringify(ast, null, 2) + '\n',
  );
  writeFileSync(
    new URL('./evidence/measurements.json', import.meta.url),
    JSON.stringify(report, null, 2) + '\n',
  );
  console.log(JSON.stringify(report, null, 2));
} finally {
  await client.query(`DROP TABLE IF EXISTS ${quote(table)}`).catch(() => {});
  await client.end();
  rmSync(directory, { recursive: true, force: true });
}
