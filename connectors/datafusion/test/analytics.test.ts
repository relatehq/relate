import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DuckDBInstance } from '@duckdb/node-api';
import { afterEach, expect, it } from 'vitest';
import { datafusion } from '@relate/connector-datafusion';
import { aggregate, column, options, query } from './fixtures.js';

const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.reverse()) await cleanup();

  cleanups.length = 0;
});

async function fixture(
  sql = `SELECT * FROM (VALUES
  ('acme', 'login', 9007199254740993::BIGINT, 2::INTEGER, 1.25::DOUBLE, true),
  ('acme', 'LOGIN', 2::BIGINT, 4::INTEGER, 2.75::DOUBLE, false),
  ('nulls', NULL, NULL, NULL, NULL, NULL),
  ('other', 'login', 100, 99, 99, true)
) t(customer_id, kind, amount, small, ratio, enabled)`,
) {
  const directory = await mkdtemp(join(tmpdir(), 'relate-datafusion-'));

  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'events.parquet');
  const db = await DuckDBInstance.create(':memory:');
  const writer = await db.connect();

  try {
    await writer.run(`COPY (${sql}) TO '${path}' (FORMAT PARQUET)`);
  } finally {
    writer.closeSync();
    db.closeSync();
  }

  const connection = datafusion({
    connectionId: 'analytics',
    onDiagnostic: (d) => console.error(d),
  });

  cleanups.push(() => connection.close());
  const resource = connection.parquet(path).bindDataset({
    columns: {
      customerId: 'customer_id',
      kind: 'kind',
      amount: 'amount',
      small: 'small',
      ratio: 'ratio',
      enabled: 'enabled',
    },
  });

  return { connection, resource, path };
}

it('executes portable aggregate families with exact integers, empty slots and nulls', async () => {
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
  ];
  const result = await connection.analytics.execute(
    connection.analytics.plan(query(resource, aggregates)),
    options(),
  );

  expect(result.rows.map((row) => row.values)).toEqual([
    [2n, 2n, 9007199254740995n, 3, 2, 4, true, 'LOGIN'],
    [0n, 0n, null, null, null, null, null, null],
    [1n, 0n, null, null, null, null, null, null],
  ]);
});
it('preserves duplicate slots and validity masks', async () => {
  const { connection, resource } = await fixture();
  const request = query(
    resource,
    [aggregate('count', '*', 'int64')],
    ['acme', 'acme', 'ACME'],
  );
  const result = await connection.analytics.execute(
    connection.analytics.plan({
      ...request,
      slots: request.slots.map((slot, i) => ({ ...slot, valid: [i !== 1] })),
    }),
    options(),
  );

  expect(result.rows.map((row) => row.values)).toEqual([[2n], [0n], [0n]]);
});
it('reports integer overflow on only the affected cell and preserves exact cancellation', async () => {
  const { connection, resource } = await fixture(
    `SELECT * FROM (VALUES ('overflow', 9223372036854775807::BIGINT), ('overflow', 1), ('cancel', 9223372036854775807), ('cancel', 1), ('cancel', -1)) t(customer_id, amount)`,
  );
  const result = await connection.analytics.execute(
    connection.analytics.plan(
      query(
        resource,
        [
          aggregate('sum', column('amount', 'int64'), 'int64'),
          aggregate('count', '*', 'int64'),
        ],
        ['overflow', 'cancel'],
      ),
    ),
    options(),
  );

  expect(result.rows.map((row) => row.values)).toEqual([
    [null, 2n],
    [9223372036854775807n, 3n],
  ]);
  expect(result.rows.map((row) => row.checks)).toEqual([
    [{ arithmeticFailed: true }, { arithmeticFailed: false }],
    [{ arithmeticFailed: false }, { arithmeticFailed: false }],
  ]);
});
it('describes physical types without inventing unsupported columns', async () => {
  const { connection, resource } = await fixture();
  const schema = await connection.analytics.describe(resource, options());

  expect(schema.columns.amount!.supportedTypes).toEqual([{ type: 'int64' }]);
  expect(schema.columns.small!.supportedTypes).toEqual([{ type: 'int32' }]);
  expect(schema.columns.customerId!.supportedTypes).toEqual([
    { type: 'string' },
  ]);
});

it('accepts a host-built custom provider through the same connector contract', async () => {
  const { fileURLToPath } = await import('node:url');
  const connection = datafusion({
    connectionId: 'custom',
    enginePath: fileURLToPath(
      new URL(
        '../engine/target/debug/examples/custom-provider',
        import.meta.url,
      ),
    ),
  });

  cleanups.push(() => connection.close());
  const resource = connection
    .custom('demo-events', { customerId: 'acme' })
    .bindDataset({ columns: { customerId: 'customerId', amount: 'amount' } });
  const result = await connection.analytics.execute(
    connection.analytics.plan(
      query(
        resource,
        [aggregate('sum', column('amount', 'int64'), 'int64')],
        ['acme', 'other'],
      ),
    ),
    options(),
  );

  expect(result.rows.map((row) => row.values)).toEqual([
    [9007199254740995n],
    [null],
  ]);
});

it('rejects foreign handles, frozen-plan mutations and invalid queries before execution', async () => {
  const { connection, resource } = await fixture();
  const other = datafusion({ connectionId: 'other' });

  cleanups.push(() => other.close());
  const request = query(resource, [aggregate('count', '*', 'int64')]);

  expect(() => other.analytics.plan(request)).toThrow(/Foreign/);
  const plan = connection.analytics.plan(request);

  await expect(other.analytics.execute(plan, options())).rejects.toThrow(
    /Foreign/,
  );
  expect(() =>
    connection.analytics.plan({ ...request, correlation: [] }),
  ).toThrow();
  const result = await connection.analytics.execute(plan, options());

  expect(result.rows[0]!.values).toEqual([2n]);
  await connection.close();
  await expect(
    connection.analytics.execute(plan, options()),
  ).rejects.toMatchObject({ retryable: false });
});

it('cancels real engine startup and permits a later read', async () => {
  const { connection, resource } = await fixture();
  const plan = connection.analytics.plan(
    query(resource, [aggregate('count', '*', 'int64')]),
  );
  const controller = new AbortController();

  await expect(
    connection.analytics.execute(plan, {
      ...options(),
      signal: controller.signal,
      onTiming(t) {
        if (t.stage === 'connectionStartup') controller.abort();
      },
    }),
  ).rejects.toMatchObject({ name: 'AbortError' });
  expect(
    (await connection.analytics.execute(plan, options())).rows[0]!.values,
  ).toEqual([2n]);
});
