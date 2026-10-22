import { expect, it, onTestFinished } from 'vitest';
import { duckdb } from '@relate/connector-duckdb';
import { render } from '../src/plan.js';
import { aggregate, column, query } from './fixtures.js';

it('quotes every physical identifier, binds every value and reports the exact parameter budget', async () => {
  const connection = duckdb({
    connectionId: 'pg',
    path: '/unused.duckdb',
  });

  onTestFinished(() => connection.close());
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
  expect(plan.sql).toContain('COLLATE "binary"');
  expect(plan.sql).not.toContain('DROP TABLE');
  expect(plan.values).toContain("x'); DROP TABLE events; --");
  expect(connection.analytics.limits.maxConcurrentStatements).toBe(4);
  const budget = connection.analytics.parameterBudget(request);

  expect(plan.values.length).toBe(
    budget.fixed + budget.perSlot * request.slots.length,
  );
  expect(connection.analytics.plan(request)).toEqual({});
  await connection.close();
});

it('enforces the 65535 parameter bound and connection-owned opaque handles before opening clients', async () => {
  const connection = duckdb({
    connectionId: 'pg',
    path: '/unused.duckdb',
  });

  onTestFinished(() => connection.close());
  const other = duckdb({
    connectionId: 'other',
    path: '/unused.duckdb',
  });

  onTestFinished(() => other.close());
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

it('counts and binds generated timestamp formatting values in the fixed budget', async () => {
  const connection = duckdb({
    connectionId: 'pg',
    path: '/unused.duckdb',
  });

  onTestFinished(() => connection.close());
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
    fixed: 1,
    perSlot: 3,
  });
  expect(plan.values).toHaveLength(4);
  expect(plan.sql).not.toContain('YYYY');
  expect(plan.sql).not.toContain("'UTC'");
  await connection.close();
});
