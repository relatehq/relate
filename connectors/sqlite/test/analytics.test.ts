import { fork } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, onTestFinished, expect, it } from 'vitest';
import { sqlite } from '@relate/connector-sqlite';
import { DatasetExecutionError } from 'relate/connectors';
import type {
  AuthorizedDatasetQuery,
  ResolvedAggregate,
  ResolvedAggregateLeaf,
  ResolvedOperand,
  TypedValue,
  AnalyticalExecutionTiming,
} from 'relate/connectors';
import { encodeAnalyticalValue } from 'relate/analytics';
import { bind, defineApp } from 'relate';
import { startApp } from '@relate/node';
import { createAnalyticalGraph } from '../../../tests/support/analytical-graph.js';
import { render } from '../src/analytics/plan.js';

const cleanups: (() => void | Promise<void>)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.reverse()) await cleanup();

  cleanups.length = 0;
});
const options = () => ({
  signal: new AbortController().signal,
  timeoutMs: 2000,
});

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'relate-analytics-'));

  cleanups.push(() => rmSync(directory, { force: true, recursive: true }));
  const path = join(directory, 'events.sqlite');
  const db = new DatabaseSync(path);

  db.exec(`CREATE TABLE events (customer_id TEXT COLLATE NOCASE NOT NULL, kind TEXT, amount INTEGER, small INTEGER, ratio REAL, enabled INTEGER, at TEXT, precise_at TEXT);
    CREATE INDEX events_customer ON events(customer_id COLLATE BINARY);
    INSERT INTO events VALUES ('acme', 'login', 9007199254740993, 2, 1.25, 1, '2026-10-01T00:00:00.000Z', '2026-10-01T00:00:00.000000Z');
    INSERT INTO events VALUES ('acme', 'LOGIN', 2, 4, 2.75, 0, '2026-10-02T00:00:00.000Z', '2026-10-02T00:00:00.123456Z');
    INSERT INTO events VALUES ('nulls', NULL, NULL, NULL, NULL, NULL, NULL, NULL);
    INSERT INTO events VALUES ('other', 'login', 100, 99, 99.0, 1, '2026-10-03T00:00:00.000Z', '2026-10-03T00:00:00.000000Z');`);
  cleanups.push(() => db.close());
  const connection = sqlite({ connectionId: 'analytics', path });

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

  return { db, path, connection, resource, columns };
}

function column(
  column: string,
  type: TypedValue['type'],
  precision: 3 | 6 = 3,
): ResolvedOperand {
  return {
    kind: 'column',
    column,
    type: type === 'timestamp' ? { type, precision } : { type },
  };
}

function aggregate(
  name: ResolvedAggregateLeaf['aggregate'],
  argument: ResolvedOperand | '*',
  type: TypedValue['type'],
  precision: 3 | 6 = 3,
): ResolvedAggregateLeaf {
  return {
    aggregate: name,
    argument,
    distinct: false,
    result: {
      ...(type === 'timestamp' ? { type, precision } : { type }),
      nullable: name !== 'count',
    },
  };
}

function query(
  resource: AuthorizedDatasetQuery['resource'],
  aggregates: readonly ResolvedAggregate[],
  customers = ['acme', 'empty', 'nulls'],
): AuthorizedDatasetQuery {
  return {
    resource,
    keys: [{ type: { type: 'string' } }],
    correlation: [{ column: 'customerId', key: 0 }],
    aggregates,
    slots: customers.map((value) => ({
      values: [{ type: 'string', value }],
      valid: aggregates.map(() => true),
    })),
  };
}

it('describes declared affinity/nullability and maps physical identifiers without scanning rows', async () => {
  const { connection, resource, db } = fixture();

  db.exec('ALTER TABLE events ADD COLUMN unsupported NUMERIC');
  db.exec('ALTER TABLE events ADD COLUMN day DATE');
  const selected = connection.table('events').bindDataset({
    columns: {
      key: 'CUSTOMER_ID',
      numeric: 'unsupported',
      day: 'day',
      missing: 'absent',
    },
  });
  const schema = await connection.analytics.describe(selected, options());

  expect(schema.columns.key).toEqual({
    supportedTypes: [
      { type: 'string' },
      { type: 'timestamp', precision: 3 },
      { type: 'timestamp', precision: 6 },
      { type: 'date' },
    ],
    nullable: false,
    databaseType: 'TEXT',
  });
  expect(schema.columns.numeric!.supportedTypes).toEqual([]);
  // DATE has NUMERIC affinity like DATETIME, but stores canonical dates as TEXT.
  expect(schema.columns.day).toEqual({
    ...schema.columns.key,
    nullable: true,
    databaseType: 'DATE',
  });
  expect(schema.columns).not.toHaveProperty('missing');
  expect(
    (await connection.analytics.describe(resource, options())).columns.amount!
      .supportedTypes,
  ).toEqual([{ type: 'boolean' }, { type: 'int32' }, { type: 'int64' }]);
});

it('executes all aggregate/scalar families with exact int64, empty and all-null semantics', async () => {
  const { connection, resource } = fixture();
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
  const result = await connection.analytics.execute(
    connection.analytics.plan(query(resource, aggregates)),
    options(),
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
  expect(result.readAt).toMatch(/^\d{4}-.*Z$/);
  expect(
    result.rows[0]!.values.map((value, i) =>
      encodeAnalyticalValue(value, aggregates[i]!.result),
    )[2],
  ).toBe('9007199254740995');
});

it('keeps correlation and masks outside OR predicates and groups duplicate keys by slot', async () => {
  const { connection, resource } = fixture();
  const count = aggregate('count', '*', 'int64');
  const filtered: ResolvedAggregate = {
    ...count,
    predicate: {
      kind: 'compare',
      op: '>=',
      left: column('small', 'int32'),
      right: { kind: 'key', key: 1, type: { type: 'int32' } },
    },
  };
  const broad: ResolvedAggregate = {
    ...count,
    predicate: {
      kind: 'boolean',
      op: 'or',
      args: [
        {
          kind: 'compare',
          op: '=',
          left: column('kind', 'string'),
          right: { kind: 'value', value: { type: 'string', value: 'login' } },
        },
        {
          kind: 'compare',
          op: '=',
          left: { kind: 'value', value: { type: 'int32', value: 1 } },
          right: { kind: 'value', value: { type: 'int32', value: 1 } },
        },
      ],
    },
  };
  const input: AuthorizedDatasetQuery = {
    ...query(resource, [filtered, broad], []),
    keys: [{ type: { type: 'string' } }, { type: { type: 'int32' } }],
    slots: [
      {
        values: [
          { type: 'string', value: 'acme' },
          { type: 'int32', value: 2 },
        ],
        valid: [true, false],
      },
      {
        values: [
          { type: 'string', value: 'acme' },
          { type: 'int32', value: 4 },
        ],
        valid: [true, true],
      },
      {
        values: [
          { type: 'string', value: 'ACME' },
          { type: 'int32', value: 1 },
        ],
        valid: [true, true],
      },
    ],
  };
  const result = await connection.analytics.execute(
    connection.analytics.plan(input),
    options(),
  );

  expect(result.rows).toEqual([
    {
      slot: 0,
      values: [2n, 0n],
      checks: [{ arithmeticFailed: false }, { arithmeticFailed: false }],
    },
    {
      slot: 1,
      values: [1n, 2n],
      checks: [{ arithmeticFailed: false }, { arithmeticFailed: false }],
    },
    {
      slot: 2,
      values: [0n, 0n],
      checks: [{ arithmeticFailed: false }, { arithmeticFailed: false }],
    },
  ]);
});

it('compares timestamp precision exactly for predicates and correlation', async () => {
  const { connection, resource } = fixture();
  const count: ResolvedAggregate = {
    ...aggregate('count', '*', 'int64'),
    predicate: {
      kind: 'compare',
      op: '=',
      left: column('preciseAt', 'timestamp', 6),
      right: column('at', 'timestamp', 3),
    },
  };

  expect(
    (
      await connection.analytics.execute(
        connection.analytics.plan(query(resource, [count])),
        options(),
      )
    ).rows.map((row) => row.values),
  ).toEqual([[1n], [0n], [0n]]);
  const input: AuthorizedDatasetQuery = {
    ...query(resource, [aggregate('count', '*', 'int64')], []),
    keys: [{ type: { type: 'timestamp', precision: 3 } }],
    correlation: [{ column: 'preciseAt', key: 0 }],
    slots: [
      {
        values: [
          {
            type: 'timestamp',
            precision: 3,
            value: '2026-10-01T00:00:00.000Z',
          },
        ],
        valid: [true],
      },
    ],
  };

  expect(
    (
      await connection.analytics.execute(
        connection.analytics.plan(input),
        options(),
      )
    ).rows[0]!.values,
  ).toEqual([1n]);
});

it('binds typed numeric constants and hostile strings and quotes configured identifiers', async () => {
  const { connection, resource, db } = fixture();
  const count: ResolvedAggregate = {
    ...aggregate('count', '*', 'int64'),
    predicate: {
      kind: 'compare',
      op: '<',
      left: { kind: 'value', value: { type: 'int64', value: 2n } },
      right: { kind: 'value', value: { type: 'int64', value: 10n } },
    },
  };

  expect(
    (
      await connection.analytics.execute(
        connection.analytics.plan(
          query(resource, [count], ['acme', "x' OR 1=1 --"]),
        ),
        options(),
      )
    ).rows.map((row) => row.values),
  ).toEqual([[2n], [0n]]);
  db.exec(
    'CREATE TABLE "odd \' ; DROP TABLE events --" ("k\"\"ey" TEXT NOT NULL)',
  );
  const named = connection
    .table("odd ' ; DROP TABLE events --")
    .bindDataset({ columns: { customerId: 'k"ey' } });

  expect(
    (
      await connection.analytics.execute(
        connection.analytics.plan(query(named, [count])),
        options(),
      )
    ).rows.map((row) => row.values),
  ).toEqual([[0n], [0n], [0n]]);
  expect(db.prepare('SELECT COUNT(*) AS n FROM events').get()!.n).toBe(4);
});

it('reports an exact conservative parameter budget and enforces the actual count', () => {
  const { connection, resource, columns } = fixture();
  const input = query(resource, [
    {
      ...aggregate('sum', column('amount', 'int64'), 'int64'),
      fallback: { type: 'int64', value: 0n },
      predicate: {
        kind: 'compare',
        op: '>',
        left: column('amount', 'int64'),
        right: { kind: 'value', value: { type: 'int64', value: 2n } },
      },
    },
  ]);
  const budget = connection.analytics.parameterBudget(input);
  const generated = render(input, { table: 'events', columns }, input.slots);

  expect(generated.values.length).toBe(
    budget.fixed + budget.perSlot * input.slots.length,
  );
  // Numbered binds may repeat; every value is bound exactly once.
  expect(new Set(generated.sql.match(/\?\d+/g))).toHaveProperty(
    'size',
    generated.values.length,
  );
  expect(() =>
    connection.analytics.plan({
      ...input,
      slots: Array.from({ length: 11000 }, () => input.slots[0]!),
    }),
  ).toThrow('parameter limit');
  const plan = connection.analytics.plan(input);

  expect(Object.keys(plan)).toEqual([]);
  expect(Object.isFrozen(plan)).toBe(true);
});

it('keeps the correlation index usable for the normal string-key query', () => {
  const { resource, columns, db } = fixture();
  const input = query(resource, [aggregate('count', '*', 'int64')]);
  const generated = render(input, { table: 'events', columns }, input.slots);
  const rows = db
    .prepare(`EXPLAIN QUERY PLAN ${generated.sql}`)
    .all(
      Object.fromEntries(
        generated.values.map((value, i) => [`?${i + 1}`, value]),
      ),
    );

  expect(rows.map((row) => row.detail).join(' ')).toMatch(
    /SEARCH d USING (?:COVERING )?INDEX events_customer/,
  );
});

it('rejects foreign and retired resources/plans and isolates keyed source reads', async () => {
  const { path, connection, resource } = fixture();
  const other = sqlite({ connectionId: 'other', path });

  cleanups.push(() => other.close());
  const plan = connection.analytics.plan(
    query(resource, [aggregate('count', '*', 'int64')]),
  );

  expect(() =>
    other.analytics.plan(query(resource, [aggregate('count', '*', 'int64')])),
  ).toThrow('Foreign');
  await expect(other.analytics.execute(plan, options())).rejects.toThrow(
    'Foreign',
  );
  const keyed = connection.table('events', {
    idColumn: 'customer_id',
    columns: ['kind'],
  });

  expect(keyed.connection).toBe(connection);
  expect(typeof keyed.bindDataset).toBe('function');
  await connection.close();
  await expect(
    connection.analytics.execute(plan, options()),
  ).rejects.toMatchObject({ code: 'execution-failed', retryable: false });
  await expect(
    connection.analytics.describe(resource, options()),
  ).rejects.toBeInstanceOf(DatasetExecutionError);
});

it('checks sum overflow per cell and distinguishes unframeable results from per-value validation', async () => {
  const { db, connection, resource } = fixture();

  db.exec(
    "INSERT INTO events(customer_id, amount) VALUES ('overflow', 9223372036854775807), ('overflow', 1)",
  );
  const sum = aggregate('sum', column('amount', 'int64'), 'int64');
  const count = aggregate('count', '*', 'int64');

  await expect(
    connection.analytics.execute(
      connection.analytics.plan(query(resource, [sum, count], ['overflow'])),
      options(),
    ),
  ).resolves.toMatchObject({
    rows: [
      {
        values: [null, 2n],
        checks: [{ arithmeticFailed: true }, { arithmeticFailed: false }],
      },
    ],
  });
  db.exec("INSERT INTO events(customer_id, kind) VALUES ('blob', X'01')");
  await expect(
    connection.analytics.execute(
      connection.analytics.plan(
        query(
          resource,
          [aggregate('max', column('kind', 'string'), 'string')],
          ['blob'],
        ),
      ),
      options(),
    ),
  ).rejects.toMatchObject({ code: 'invalid-result' });
  db.exec(
    "INSERT INTO events(customer_id, enabled, at) VALUES ('invalid', 3, 'not-an-instant')",
  );
  const input = query(
    resource,
    [
      aggregate('max', column('enabled', 'boolean'), 'boolean'),
      aggregate('max', column('at', 'timestamp'), 'timestamp'),
    ],
    ['invalid'],
  );
  const result = await connection.analytics.execute(
    connection.analytics.plan(input),
    options(),
  );

  for (const [i, value] of result.rows[0]!.values.entries())
    expect(() =>
      encodeAnalyticalValue(value, input.aggregates[i]!.result),
    ).toThrow();
});

it('reports startup and execution once, and observer errors never fail a query', async () => {
  const { connection, resource } = fixture();
  const timings: AnalyticalExecutionTiming[] = [];
  const plan = connection.analytics.plan(
    query(resource, [aggregate('count', '*', 'int64')]),
  );
  const result = await connection.analytics.execute(plan, {
    ...options(),
    onTiming(timing) {
      timings.push(timing);
      throw new Error('observer failure');
    },
  });

  expect(result.rows[0]!.values).toEqual([2n]);
  expect(timings.map((timing) => timing.stage)).toEqual([
    'connectionStartup',
    'execution',
  ]);

  for (const timing of timings)
    expect(Number.isFinite(timing.durationMs) && timing.durationMs >= 0).toBe(
      true,
    );
});

it('reports startup alone on failed open, and omits spans for an already-aborted call', async () => {
  const { path } = fixture();
  const connection = sqlite({
    connectionId: 'missing',
    path: `${path}.absent`,
  });

  cleanups.push(() => connection.close());
  const resource = connection
    .table('events')
    .bindDataset({ columns: { customerId: 'customer_id' } });
  const plan = connection.analytics.plan(
    query(resource, [aggregate('count', '*', 'int64')]),
  );
  const timings: AnalyticalExecutionTiming[] = [];

  await expect(
    connection.analytics.execute(plan, {
      ...options(),
      onTiming: (timing) => timings.push(timing),
    }),
  ).rejects.toMatchObject({ code: 'execution-failed' });
  expect(timings.map((timing) => timing.stage)).toEqual(['connectionStartup']);
  timings.length = 0;
  await expect(
    connection.analytics.execute(plan, {
      ...options(),
      signal: AbortSignal.abort('stop'),
      onTiming: (timing) => timings.push(timing),
    }),
  ).rejects.toBe('stop');
  expect(timings).toEqual([]);
});

it('binds a real SQLite dataset through public app startup and rejects incompatible physical columns', async () => {
  const { connection, db } = fixture();
  const { graph, Events } = createAnalyticalGraph();

  db.exec(
    'CREATE TABLE bound_events(customer_id TEXT NOT NULL, amount INTEGER NOT NULL, secret TEXT NOT NULL)',
  );
  const app = defineApp({
    graph,
    setup: () => ({
      bindings: [
        bind(Events, connection.table('bound_events'), {
          columns: { customerId: 'customer_id' },
        }),
      ],
    }),
  });
  const runtime = await startApp(app);

  await runtime.close();
  db.exec(
    'DROP TABLE bound_events; CREATE TABLE bound_events(customer_id TEXT NOT NULL, amount NUMERIC NOT NULL, secret TEXT NOT NULL)',
  );
  await expect(startApp(app)).rejects.toThrow('int64');
});

function slowPlan(f: ReturnType<typeof fixture>) {
  f.db.exec(
    "CREATE VIEW slow AS WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<1000000000) SELECT 'acme' AS customer_id, x AS amount FROM n",
  );
  const resource = f.connection
    .table('slow')
    .bindDataset({ columns: { customerId: 'customer_id', amount: 'amount' } });

  return f.connection.analytics.plan(
    query(
      resource,
      [aggregate('sum', column('amount', 'int64'), 'int64')],
      ['acme'],
    ),
  );
}

it('terminates native SQLite work on timeout and immediately permits a fresh statement', async () => {
  const f = fixture();
  const plan = slowPlan(f);
  const timings: AnalyticalExecutionTiming[] = [];
  const started = performance.now();

  await expect(
    f.connection.analytics.execute(plan, {
      ...options(),
      timeoutMs: 25,
      onTiming: (timing) => timings.push(timing),
    }),
  ).rejects.toMatchObject({ code: 'execution-failed', retryable: false });
  expect(performance.now() - started).toBeLessThan(2000);
  expect(timings.map((timing) => timing.stage)).toEqual([
    'connectionStartup',
    'execution',
  ]);
  expect(timings[1]!.durationMs).toBeGreaterThanOrEqual(20);
  const next = await f.connection.analytics.execute(
    f.connection.analytics.plan(
      query(f.resource, [aggregate('count', '*', 'int64')]),
    ),
    options(),
  );

  expect(next.rows[0]!.values).toEqual([2n]);
});

it('preserves the caller abort reason and reports cleanup-inclusive execution timing', async () => {
  const f = fixture();
  const plan = slowPlan(f);
  const controller = new AbortController();
  const reason = new Error('caller cancelled');
  const timings: AnalyticalExecutionTiming[] = [];
  let timer: ReturnType<typeof setTimeout> | undefined;

  try {
    await expect(
      f.connection.analytics.execute(plan, {
        signal: controller.signal,
        timeoutMs: 2000,
        onTiming(timing) {
          timings.push(timing);

          if (timing.stage === 'connectionStartup')
            timer = setTimeout(() => controller.abort(reason), 25);
        },
      }),
    ).rejects.toBe(reason);
    expect(timings.map((timing) => timing.stage)).toEqual([
      'connectionStartup',
      'execution',
    ]);
    expect(timings[1]!.durationMs).toBeLessThan(2000);
  } finally {
    clearTimeout(timer);
  }
});

it('bounds concurrent processes and closes every active analytical child before retiring', async () => {
  const f = fixture();
  const plan = slowPlan(f);
  let entered = 0;
  let ready!: () => void;
  const allReady = new Promise<void>((resolve) => {
    ready = resolve;
  });
  const tasks = Array.from({ length: 4 }, () =>
    f.connection.analytics.execute(plan, {
      ...options(),
      onTiming(timing) {
        if (timing.stage === 'connectionStartup' && ++entered === 4) ready();
      },
    }),
  );
  const results = Promise.allSettled(tasks);

  await allReady;
  await expect(
    f.connection.analytics.execute(plan, options()),
  ).rejects.toMatchObject({ retryable: true });
  const start = performance.now();

  await f.connection.close();
  expect(performance.now() - start).toBeLessThan(2000);
  expect(
    (await results).every(
      (result) =>
        result.status === 'rejected' && result.reason.name === 'AbortError',
    ),
  ).toBe(true);
  await f.connection.close();
});

it('ignores rejected promises returned by asynchronous timing observers', async () => {
  const { connection, resource } = fixture();
  const plan = connection.analytics.plan(
    query(resource, [aggregate('count', '*', 'int64')]),
  );
  const result = await connection.analytics.execute(plan, {
    ...options(),
    async onTiming() {
      throw new Error('asynchronous diagnostics failure');
    },
  });

  expect(result.rows[0]!.values).toEqual([2n]);
});

it('applies every composite correlation pair and preserves NULL-key empty behavior', async () => {
  const { connection, resource } = fixture();
  const input: AuthorizedDatasetQuery = {
    ...query(resource, [aggregate('count', '*', 'int64')], []),
    keys: [{ type: { type: 'string' } }, { type: { type: 'boolean' } }],
    correlation: [
      { column: 'customerId', key: 0 },
      { column: 'enabled', key: 1 },
    ],
    slots: [
      {
        values: [
          { type: 'string', value: 'acme' },
          { type: 'boolean', value: true },
        ],
        valid: [true],
      },
      {
        values: [
          { type: 'string', value: 'acme' },
          { type: 'boolean', value: null },
        ],
        valid: [true],
      },
    ],
  };

  expect(
    (
      await connection.analytics.execute(
        connection.analytics.plan(input),
        options(),
      )
    ).rows,
  ).toEqual([
    { slot: 0, values: [1n], checks: [{ arithmeticFailed: false }] },
    { slot: 1, values: [0n], checks: [{ arithmeticFailed: false }] },
  ]);
});

it('orders mixed timestamp precision by instant and keeps timestamp correlation indexes usable', async () => {
  const { connection, db } = fixture();

  db.exec(`CREATE TABLE instants (at TEXT NOT NULL); CREATE INDEX instants_at ON instants(at);
    INSERT INTO instants VALUES ('2026-10-01T00:00:00.123Z'), ('2026-10-01T00:00:00.123400Z');`);
  const resource = connection
    .table('instants')
    .bindDataset({ columns: { at: 'at' } });
  const request: AuthorizedDatasetQuery = {
    resource,
    keys: [{ type: { type: 'timestamp', precision: 6 } }],
    correlation: [{ column: 'at', key: 0 }],
    slots: [
      {
        values: [
          {
            type: 'timestamp',
            precision: 6,
            value: '2026-10-01T00:00:00.123000Z',
          },
        ],
        valid: [true],
      },
    ],
    aggregates: [aggregate('count', '*', 'int64')],
  };
  const plan = render(
    request,
    { table: 'instants', columns: { at: 'at' } },
    request.slots,
  );

  db.function('__relate_instant', { deterministic: true }, (value) => value);
  const explanation = db
    .prepare(`EXPLAIN QUERY PLAN ${plan.sql}`)
    .all(
      Object.fromEntries(plan.values.map((value, i) => [`?${i + 1}`, value])),
    );

  expect(JSON.stringify(explanation)).toContain('instants_at');
  const result = await connection.analytics.execute(
    connection.analytics.plan(request),
    options(),
  );

  expect(result.rows[0]!.values).toEqual([1n]);

  db.exec(
    `INSERT INTO events(customer_id, precise_at) VALUES ('mixed', '2026-10-01T00:00:00.123Z'), ('mixed', '2026-10-01T00:00:00.123400Z')`,
  );
  const events = connection
    .table('events')
    .bindDataset({ columns: { customerId: 'customer_id', at: 'precise_at' } });
  const extrema = await connection.analytics.execute(
    connection.analytics.plan(
      query(
        events,
        [
          aggregate('min', column('at', 'timestamp', 6), 'timestamp', 6),
          aggregate('max', column('at', 'timestamp', 6), 'timestamp', 6),
        ],
        ['mixed'],
      ),
    ),
    options(),
  );

  expect(extrema.rows[0]!.values).toEqual([
    '2026-10-01T00:00:00.123000Z',
    '2026-10-01T00:00:00.123400Z',
  ]);

  db.exec(
    `INSERT INTO events(customer_id, precise_at) VALUES ('mixed', '2026-10-01T00:00:00.123000Z')`,
  );
  const distinct = await connection.analytics.execute(
    connection.analytics.plan(
      query(
        events,
        [
          {
            ...aggregate('count', column('at', 'timestamp', 6), 'int64'),
            distinct: true,
          },
        ],
        ['mixed'],
      ),
    ),
    options(),
  );

  // '.123Z' and '.123000Z' are one instant, as in PostgreSQL timestamptz.
  expect(distinct.rows[0]!.values).toEqual([2n]);
});

it('enforces a child-local deadline while SQLite blocks without a parent execution timer', async () => {
  const { path } = fixture();
  const child = fork(
    new URL('../dist/analytics/child.js', import.meta.url),
    [],
    { stdio: ['ignore', 'ignore', 'ignore', 'ipc'], execArgv: [] },
  );

  onTestFinished(() => {
    child.kill('SIGKILL');
  });
  const closed = once(child, 'close');

  child.send({ kind: 'open', path, busyTimeoutMs: 1, lifetimeMs: 400 });
  const [message] = await once(child, 'message');

  expect(message).toEqual({ kind: 'ready' });
  child.send({
    kind: 'execute',
    plan: {
      sql: 'WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<1000000000) SELECT 0 AS slot, SUM(x) AS v0 FROM n',
      values: [],
      slots: 1,
      results: [{ type: 'int64', nullable: false }],
    },
  });
  const [, signal] = await closed;

  expect(signal).toBe('SIGKILL');
});
