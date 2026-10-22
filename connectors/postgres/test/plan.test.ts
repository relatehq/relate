import { expect, it } from 'vitest';
import { postgres } from '@relate/connector-postgres';
import { render } from '../src/plan.js';
import { decode } from '../src/results.js';
import { aggregate, column, query } from './fixtures.js';

it('quotes every physical identifier, binds every value and reports the exact parameter budget', async () => {
  const connection = postgres({
    connectionId: 'pg',
    url: 'postgres://localhost/test',
  });
  const resource = connection
    .table('odd";table', { schema: 'odd"schema' })
    .bindDataset({ columns: { customerId: 'odd"key', amount: 'amount' } });
  const request = query(
    resource,
    [
      aggregate('sum', column('amount', 'int64'), 'int64'),
      aggregate('count', '*', 'int64'),
    ],
    ["x'); DROP TABLE events; --", 'acme'],
  );
  const plan = render(
    request,
    {
      schema: 'odd"schema',
      table: 'odd";table',
      columns: { customerId: 'odd"key', amount: 'amount' },
    },
    request.slots,
  );

  expect(plan.sql).toContain('"odd""schema"."odd"";table"');
  expect(plan.sql).toContain('"odd"";table"');
  expect(plan.sql).not.toContain('COLLATE pg_catalog."C"');
  expect(plan.sql).not.toContain('DROP TABLE');
  expect(plan.values).toContain("x'); DROP TABLE events; --");
  const budget = connection.analytics.parameterBudget(request);

  expect(plan.values.length).toBe(
    budget.fixed + budget.perSlot * request.slots.length,
  );
  expect(connection.analytics.plan(request)).toEqual({});
  await connection.close();
});

it('enforces the 65535 parameter bound and connection-owned opaque handles before opening clients', async () => {
  const connection = postgres({
    connectionId: 'pg',
    url: 'postgres://localhost/test',
  });
  const other = postgres({
    connectionId: 'other',
    url: 'postgres://localhost/test',
  });
  const resource = connection
    .table('events')
    .bindDataset({ columns: { customerId: 'customer_id' } });
  const base = query(resource, [aggregate('count', '*', 'int64')], ['acme']);
  const budget = connection.analytics.parameterBudget(base);
  const slots = Math.floor((65535 - budget.fixed) / budget.perSlot);

  expect(() =>
    connection.analytics.plan({
      ...base,
      slots: Array.from({ length: slots }, () => base.slots[0]!),
    }),
  ).not.toThrow();
  expect(() =>
    connection.analytics.plan({
      ...base,
      slots: Array.from({ length: slots + 1 }, () => base.slots[0]!),
    }),
  ).toThrow(/parameter limit/);
  expect(() => other.analytics.plan(base)).toThrow(/Foreign/);
  const plan = connection.analytics.plan(base);

  await expect(
    other.analytics.execute(plan, {
      signal: new AbortController().signal,
      timeoutMs: 1,
    }),
  ).rejects.toThrow(/Foreign/);
  await connection.close();
  await other.close();
  expect(() => connection.analytics.plan(base)).toThrow(
    /Analytical execution failed/,
  );
});

it('preserves invalid scalar values for alias withdrawal but rejects malformed row frames', () => {
  const plan = {
    sql: '',
    values: [],
    slots: 1,
    results: [
      { type: 'int64' as const, nullable: true },
      { type: 'float64' as const, nullable: true },
      { type: 'timestamp' as const, precision: 6 as const, nullable: true },
      { type: 'boolean' as const, nullable: true },
    ],
  };
  const readAt = '2026-10-21T00:00:00.000Z';

  expect(
    decode(
      plan,
      [['0', '9007199254740995', 'NaN', '0002-01-01T00:00:00.000000ZBC', 't']],
      readAt,
    ).rows[0]!.values,
  ).toEqual([9007199254740995n, NaN, '0002-01-01T00:00:00.000000ZBC', true]);
  expect(() =>
    decode(plan, [['1', '1', '2', 'infinity', 't']], readAt),
  ).toThrow(/Invalid analytical result/);
  expect(() => decode(plan, [], readAt)).toThrow(/Invalid analytical result/);
});

it('counts and binds generated timestamp formatting values in the fixed budget', async () => {
  const connection = postgres({
    connectionId: 'pg',
    url: 'postgres://localhost/test',
  });
  const resource = connection
    .table('events')
    .bindDataset({ columns: { customerId: 'customer_id', at: 'at' } });
  const request = query(
    resource,
    [aggregate('max', column('at', 'timestamp', 6), 'timestamp', 6)],
    ['acme'],
  );
  const plan = render(
    request,
    {
      table: 'events',
      schema: 'public',
      columns: { customerId: 'customer_id', at: 'at' },
    },
    request.slots,
  );

  expect(connection.analytics.parameterBudget(request)).toEqual({
    fixed: 3,
    perSlot: 3,
  });
  expect(plan.values).toHaveLength(6);
  expect(plan.sql).not.toContain('YYYY');
  expect(plan.sql).not.toContain("'UTC'");
  await connection.close();
});
