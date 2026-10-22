import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DuckDBInstance } from '@duckdb/node-api';
import { bind, defineApp } from 'relate';
import { compile } from 'relate/compiler';
import { startApp } from '@relate/node';
import { createMemoryStore } from '@relate/runtime';
import { createAnalyticalGraph } from '../../../tests/support/analytical-graph.js';
import { testCreation } from '../../../tests/support/activity.js';
import { afterEach, expect, it } from 'vitest';
import { duckdb } from '@relate/connector-duckdb';
import type { AnalyticalExecutionTiming } from 'relate/connectors';
import { aggregate, column, options, query } from './fixtures.js';
import { createProcessRunner } from '../dist/process.js';
import { encodeAnalyticalValue } from 'relate/analytics';

const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.reverse()) await cleanup();

  cleanups.length = 0;
});

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'relate-duckdb-'));

  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'analytics.duckdb');
  const db = await DuckDBInstance.create(path);
  const writer = await db.connect();

  try {
    await writer.run(`CREATE TABLE events(customer_id VARCHAR NOT NULL, kind VARCHAR, amount BIGINT, small INTEGER, ratio DOUBLE, enabled BOOLEAN, "at" TIMESTAMP_MS, precise_at TIMESTAMP);
      INSERT INTO events VALUES ('acme','login',9007199254740993,2,1.25,true,'2026-10-01T00:00:00.000','2026-10-01T00:00:00.000000'),
      ('acme','LOGIN',2,4,2.75,false,'2026-10-02T00:00:00.000','2026-10-02T00:00:00.123456'),
      ('nulls',NULL,NULL,NULL,NULL,NULL,NULL,NULL), ('other','login',100,99,99,true,'2026-10-03','2026-10-03');
      CREATE TABLE host_events(customer_id VARCHAR NOT NULL, amount BIGINT NOT NULL, secret VARCHAR NOT NULL);
      INSERT INTO host_events VALUES ('acme',9007199254740993,'private'),('acme',2,'private');
      CREATE VIEW slow AS SELECT 'acme' AS customer_id, i AS amount FROM range(10000000000) t(i);
      CREATE TABLE overflow AS SELECT 'acme' AS customer_id, 9223372036854775807::BIGINT AS amount UNION ALL SELECT 'acme',1;
      CREATE TABLE integer_keys(customer_id BIGINT, amount BIGINT);
      INSERT INTO integer_keys VALUES (9007199254740993,3),(9007199254740994,7);
      CREATE TABLE wide_ms(customer_id VARCHAR, value TIMESTAMP_MS);
      INSERT INTO wide_ms VALUES ('early','0001-01-01 00:00:00.123'),('late','2300-01-01 00:00:00.123'),('zero','0000-02-29 00:00:00.123');
      CREATE TABLE temporal(customer_id VARCHAR, precise_at TIMESTAMP);
      INSERT INTO temporal VALUES ('ancient','0000-02-29 00:00:00.123456'),('infinite','infinity');
      CREATE TABLE unsupported(decimal DECIMAL, narrow FLOAT, zoned TIMESTAMPTZ, nano TIMESTAMP_NS);
      CREATE VIEW external AS SELECT * FROM read_csv('/etc/passwd', header=false);`);
  } finally {
    writer.closeSync();
    db.closeSync();
  }

  const connection = duckdb({ connectionId: 'analytics', path });

  cleanups.push(() => connection.close());
  const columns = {
    customerId: 'customer_id',
    kind: 'kind',
    amount: 'amount',
    small: 'small',
    ratio: 'ratio',
    enabled: 'enabled',
    at: 'at',
    preciseAt: 'precise_at',
  };
  const resource = connection.table('events').bindDataset({ columns });

  return { connection, resource, path };
}

it('executes all portable aggregate families with exact integers and timestamps', async () => {
  const { connection, resource } = await fixture();
  const aggregates = [
    aggregate('count', '*', 'int64'),
    {
      ...aggregate('count', column('kind', 'string'), 'int64'),
      distinct: true,
    },
    aggregate('sum', column('amount', 'int64'), 'int64'),
    aggregate('avg', column('small', 'int32'), 'float64'),
    aggregate('min', column('small', 'int32'), 'int32'),
    aggregate('sum', column('ratio', 'float64'), 'float64'),
    aggregate('max', column('enabled', 'boolean'), 'boolean'),
    aggregate('min', column('kind', 'string'), 'string'),
    aggregate('max', column('at', 'timestamp'), 'timestamp'),
    aggregate('max', column('preciseAt', 'timestamp', 6), 'timestamp', 6),
    {
      ...aggregate('sum', column('small', 'int32'), 'int64'),
      fallback: { type: 'int64' as const, value: 7n },
      result: { type: 'int64' as const, nullable: false },
    },
  ];
  const timings: AnalyticalExecutionTiming[] = [];
  const result = await connection.analytics.execute(
    connection.analytics.plan(query(resource, aggregates)),
    { ...options(), onTiming: (timing) => timings.push(timing) },
  );

  expect(result.rows.map((row) => row.values)).toEqual([
    [
      2n,
      2n,
      9007199254740995n,
      3,
      2,
      4,
      true,
      'LOGIN',
      '2026-10-02T00:00:00.000Z',
      '2026-10-02T00:00:00.123456Z',
      6n,
    ],
    [0n, 0n, null, null, null, null, null, null, null, null, 7n],
    [1n, 0n, null, null, null, null, null, null, null, null, 7n],
  ]);
  expect(timings.map((timing) => timing.stage)).toEqual([
    'connectionStartup',
    'execution',
  ]);
  expect(result.readAt).toMatch(/^\d{4}-.*Z$/);
});

it('keeps duplicate keys in distinct slots, masks unavailable inputs and contains caller predicates inside correlation', async () => {
  const { connection, resource } = await fixture();
  const count = {
    ...aggregate('count', '*', 'int64'),
    predicate: {
      kind: 'compare' as const,
      op: '=' as const,
      left: {
        kind: 'value' as const,
        value: { type: 'int64' as const, value: 1n },
      },
      right: {
        kind: 'value' as const,
        value: { type: 'int64' as const, value: 1n },
      },
    },
  };
  const request = query(resource, [count], ['acme', 'acme', 'ACME', 'empty']);
  const result = await connection.analytics.execute(
    connection.analytics.plan({
      ...request,
      slots: request.slots.map((slot, index) => ({
        ...slot,
        valid: [index !== 1],
      })),
    }),
    options(),
  );

  expect(result.rows.map((row) => row.values)).toEqual([
    [2n],
    [0n],
    [0n],
    [0n],
  ]);
});

it('reads caller and declared calculations through the public Node host on DuckDB', async () => {
  const { connection } = await fixture();

  const { graph, Customer, Events } = createAnalyticalGraph();
  const model = compile(graph);
  const store = createMemoryStore();
  const scope = {
    graphId: graph.id,
    definitionRevision: model.definitionRevision,
  };

  await store.install(scope.graphId, scope.definitionRevision);
  await store.native!.transaction(scope, (transaction) =>
    transaction.insert(
      {
        objectDefinitionId: Customer.id,
        objectId: 'one',
        createdAt: 0,
        values: { 'customer.external': 'acme', 'customer.label': 'Acme' },
      },
      testCreation(),
    ),
  );
  const runtime = await startApp(
    defineApp({
      graph,
      setup: () => ({
        store,
        bindings: [
          bind(Events, connection.table('host_events'), {
            columns: { customerId: 'customer_id' },
          }),
        ],
      }),
    }),
  );

  cleanups.push(() => runtime.close());
  const operations = runtime.operations({
    id: 'ana',
    roles: ['reader', 'analyst', 'private'],
    claims: {},
  });
  const request = {
    select: ['label', 'count'],
    compute: { total: { sql: 'SELECT SUM(amount) FROM self.events' } },
  };
  const result = await operations.get('customer', 'one', request);

  expect(result.status).toBe('ok');

  if (result.status !== 'ok') return;

  expect(result.data).toEqual({
    label: 'Acme',
    count: '2',
    total: '9007199254740995',
  });
  const page = await operations.query('customer', request);

  expect(page.data[0]!.data).toEqual(result.data);
  await runtime.host.flushActivity();
  const records = (
    await runtime.host.activity.operations.list()
  ).entries.filter((row) => row.kind === 'get' || row.kind === 'query');

  expect(records).toHaveLength(2);

  for (const row of records)
    expect(row.details.analytical!.stages.execution!.count).toBe(1);
});

it('describes exact physical types and rejects unsupported coercions', async () => {
  const { connection, resource } = await fixture();
  const schema = await connection.analytics.describe(resource, options());

  expect(schema.columns.customerId).toEqual({
    supportedTypes: [{ type: 'string' }],
    nullable: false,
    databaseType: 'VARCHAR',
  });
  expect(schema.columns.at!.supportedTypes).toEqual([
    { type: 'timestamp', precision: 3 },
  ]);
  expect(schema.columns.preciseAt!.supportedTypes).toEqual([
    { type: 'timestamp', precision: 6 },
  ]);
  expect(schema.columns.amount!.supportedTypes).toEqual([{ type: 'int64' }]);
  const unsupported = await connection.analytics.describe(
    connection.table('unsupported').bindDataset({
      columns: {
        decimal: 'decimal',
        narrow: 'narrow',
        zoned: 'zoned',
        nano: 'nano',
        missing: 'missing',
      },
    }),
    options(),
  );

  for (const name of ['decimal', 'narrow', 'zoned', 'nano'])
    expect(unsupported.columns[name]!.supportedTypes).toEqual([]);

  expect(unsupported.columns).not.toHaveProperty('missing');
});

it('fails overflowing integer sums and blocks external reads through views', async () => {
  const { connection } = await fixture();
  const resource = connection
    .table('overflow')
    .bindDataset({ columns: { customerId: 'customer_id', amount: 'amount' } });

  await expect(
    connection.analytics.execute(
      connection.analytics.plan(
        query(
          resource,
          [aggregate('sum', column('amount', 'int64'), 'int64')],
          ['acme'],
        ),
      ),
      options(),
    ),
  ).rejects.toMatchObject({ code: 'execution-failed' });
  await expect(
    connection.analytics.describe(
      connection
        .table('external')
        .bindDataset({ columns: { value: 'column0' } }),
      options(),
    ),
  ).rejects.toMatchObject({ code: 'execution-failed' });
});

it.each(['abort', 'timeout', 'retire'] as const)(
  'stops native work and permits subsequent access after %s',
  async (mode) => {
    const { connection, resource, path } = await fixture();
    const slow = connection.table('slow').bindDataset({
      columns: { customerId: 'customer_id', amount: 'amount' },
    });
    const controller = new AbortController();
    const timings: AnalyticalExecutionTiming[] = [];
    const task = connection.analytics.execute(
      connection.analytics.plan(
        query(
          slow,
          [aggregate('sum', column('amount', 'int64'), 'int64')],
          ['acme'],
        ),
      ),
      {
        signal: controller.signal,
        timeoutMs: mode === 'timeout' ? 40 : 5000,
        onTiming(timing) {
          timings.push(timing);

          if (timing.stage === 'connectionStartup' && mode !== 'timeout')
            setTimeout(() => {
              if (mode === 'abort') controller.abort();
              else void connection.close();
            }, 40);
        },
      },
    );

    await expect(task).rejects.toMatchObject(
      mode === 'timeout'
        ? { code: 'execution-failed' }
        : { name: 'AbortError' },
    );
    expect(timings.map((t) => t.stage)).toEqual([
      'connectionStartup',
      'execution',
    ]);
    // Opening a writer proves the child's read lock has been released before rejection.
    const writer = await DuckDBInstance.create(path);

    writer.closeSync();

    if (mode !== 'retire') {
      const result = await connection.analytics.execute(
        connection.analytics.plan(
          query(resource, [aggregate('count', '*', 'int64')], ['acme']),
        ),
        options(),
      );

      expect(result.rows[0]!.values).toEqual([2n]);
    }
  },
);

it('rejects pre-aborted work and invalid file options', async () => {
  const { connection, resource } = await fixture();
  const controller = new AbortController();

  controller.abort();
  await expect(
    connection.analytics.describe(resource, { signal: controller.signal }),
  ).rejects.toMatchObject({ name: 'AbortError' });
  expect(() => duckdb({ connectionId: 'a', path: ':memory:' })).toThrow(
    /existing database file/,
  );
});

it('correlates adjacent large integer keys without number conversion', async () => {
  const { connection } = await fixture();
  const resource = connection
    .table('integer_keys')
    .bindDataset({ columns: { customerId: 'customer_id', amount: 'amount' } });
  const base = query(resource, [
    aggregate('sum', column('amount', 'int64'), 'int64'),
  ]);
  const result = await connection.analytics.execute(
    connection.analytics.plan({
      ...base,
      keys: [{ type: { type: 'int64' } }],
      slots: ['9007199254740993', '9007199254740994'].map((value) => ({
        values: [{ type: 'int64', value: BigInt(value) }],
        valid: [true],
      })),
    }),
    options(),
  );

  expect(result.rows.map((row) => row.values)).toEqual([[3n], [7n]]);
});

it('preserves year zero and leaves invalid timestamps for runtime rejection', async () => {
  const { connection } = await fixture();
  const resource = connection.table('temporal').bindDataset({
    columns: { customerId: 'customer_id', preciseAt: 'precise_at' },
  });
  const maximum = aggregate(
    'max',
    column('preciseAt', 'timestamp', 6),
    'timestamp',
    6,
  );
  const result = await connection.analytics.execute(
    connection.analytics.plan(
      query(resource, [maximum], ['ancient', 'infinite']),
    ),
    options(),
  );

  expect(result.rows[0]!.values).toEqual(['0000-02-29T00:00:00.123456Z']);
  expect(() =>
    encodeAnalyticalValue(result.rows[1]!.values[0], maximum.result),
  ).toThrow();
});

it('enforces read-only access even if internal SQL attempts a write', async () => {
  const { path, connection, resource } = await fixture();
  const runner = createProcessRunner({ path, startupTimeoutMs: 5000 });

  cleanups.push(() => runner.close());
  await expect(
    runner.run(
      {
        kind: 'execute',
        plan: {
          sql: 'SELECT 0::INTEGER, COUNT(*) FROM events',
          values: [],
          slots: 1,
          results: [{ type: 'int64', nullable: false }],
        },
      },
      options(),
    ),
  ).resolves.toMatchObject({ rows: [{ slot: 0, values: [4n] }] });
  await expect(
    runner.run(
      {
        kind: 'execute',
        plan: { sql: 'DELETE FROM events', values: [], slots: 0, results: [] },
      },
      options(),
    ),
  ).rejects.toMatchObject({ code: 'execution-failed', retryable: false });
  const result = await connection.analytics.execute(
    connection.analytics.plan(
      query(resource, [aggregate('count', '*', 'int64')], ['acme']),
    ),
    options(),
  );

  expect(result.rows[0]!.values).toEqual([2n]);
});

it('joins startup cancellation and ignores failed timing observers', async () => {
  const { connection, resource } = await fixture();
  const controller = new AbortController();
  const pending = connection.analytics.describe(resource, {
    signal: controller.signal,
  });

  controller.abort();
  await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  const result = await connection.analytics.execute(
    connection.analytics.plan(
      query(resource, [aggregate('count', '*', 'int64')], ['acme']),
    ),
    {
      ...options(),
      onTiming() {
        throw new Error('observer');
      },
    },
  );

  expect(result.rows[0]!.values).toEqual([2n]);
});

it.each(['min', 'max'] as const)(
  'formats TIMESTAMP_MS %s across the portable date range without fallback',
  async (name) => {
    const { connection } = await fixture();
    const resource = connection
      .table('wide_ms')
      .bindDataset({ columns: { customerId: 'customer_id', value: 'value' } });
    const result = await connection.analytics.execute(
      connection.analytics.plan(
        query(
          resource,
          [aggregate(name, column('value', 'timestamp', 3), 'timestamp', 3)],
          ['early', 'late', 'zero'],
        ),
      ),
      options(),
    );

    expect(result.rows.map((row) => row.values)).toEqual([
      ['0001-01-01T00:00:00.123Z'],
      ['2300-01-01T00:00:00.123Z'],
      ['0000-02-29T00:00:00.123Z'],
    ]);
  },
);

it.each([2147423648, 2147483647])(
  'accepts valid long statement timeout %s',
  async (timeoutMs) => {
    const { connection, resource } = await fixture();
    const plan = connection.analytics.plan(
      query(resource, [aggregate('count', '*', 'int64')], ['acme']),
    );

    await expect(
      connection.analytics.execute(plan, { ...options(), timeoutMs }),
    ).resolves.toMatchObject({ rows: [{ slot: 0, values: [2n] }] });
    await expect(
      connection.analytics.execute(plan, {
        ...options(),
        timeoutMs: 2147483648,
      }),
    ).rejects.toThrow('Invalid analytical statement timeout');
  },
);

it('reports missing-table and locked-file diagnostics without exposing them in public errors', async () => {
  const { path } = await fixture();
  const diagnostics: { kind: string; message: string }[] = [];
  const connection = duckdb({
    connectionId: 'diagnostics',
    path,
    onDiagnostic(item) {
      diagnostics.push(item);
      throw new Error('observer');
    },
  });

  cleanups.push(() => connection.close());
  const resource = connection
    .table('private_missing_table')
    .bindDataset({ columns: {} });
  const error = await connection.analytics
    .describe(resource, options())
    .catch((error) => error);

  expect(error.cause.message).toContain('private_missing_table');
  expect(error.message).toBe('Analytical execution failed');
  expect(JSON.stringify(error)).not.toContain('private_missing_table');
  expect(diagnostics[0]!.kind).toBe('database');
  await connection.close();
  const writer = await DuckDBInstance.create(path);

  try {
    const locked = duckdb({
      connectionId: 'locked',
      path,
      onDiagnostic(item) {
        diagnostics.push(item);
      },
    });

    cleanups.push(() => locked.close());
    await expect(
      locked.analytics.describe(
        locked.table('events').bindDataset({ columns: {} }),
        options(),
      ),
    ).rejects.toMatchObject({
      code: 'execution-failed',
      cause: { message: expect.stringMatching(/lock/i) },
    });
    expect(diagnostics.at(-1)!.kind).toBe('startup');
  } finally {
    writer.closeSync();
  }
});

it('reuses real native workers and releases idle read locks on close', async () => {
  const { connection, resource, path } = await fixture();
  const plan = connection.analytics.plan(
    query(resource, [aggregate('count', '*', 'int64')], ['acme']),
  );
  const results = await Promise.all(
    Array.from({ length: 4 }, () =>
      connection.analytics.execute(plan, options()),
    ),
  );

  for (const result of results) expect(result.rows[0]!.values).toEqual([2n]);

  const stages: string[] = [];

  await connection.analytics.execute(plan, {
    ...options(),
    onTiming: (timing) => stages.push(timing.stage),
  });
  expect(stages).toEqual(['execution']);
  await connection.close();
  const writer = await DuckDBInstance.create(path);

  writer.closeSync();
});
