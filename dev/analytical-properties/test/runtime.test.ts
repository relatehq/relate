import { expect, it, vi } from 'vitest';
import { generate } from '../generate.js';
import { createAnalyticalSpike } from '../runtime.js';
import { parseExpression } from '../parser.js';
import { association, customers, expressions } from './support.js';
import type { Backend } from '../contracts.js';

function backend(): Backend {
  return {
    dialect: 'sqlite',
    plan: (model, candidates, expressions) =>
      generate('sqlite', model, candidates, expressions),
    execute: vi.fn(async () => [
      { slot: 0n, v0: 2n },
      { slot: 1n, v0: 1n },
      { slot: 2n, v0: 0n },
    ]),
  };
}

it('hidden associations fail before execution; no candidates run no statement', async () => {
  const b = backend();

  await expect(
    createAnalyticalSpike(
      b,
      undefined,
      parseExpression,
    )(customers(), { compute: expressions() }),
  ).rejects.toThrow('unknown-property');
  const result = await createAnalyticalSpike(
    b,
    association(),
    parseExpression,
  )([], { compute: expressions() });

  expect(result.data).toEqual([]);
  expect(b.execute).not.toHaveBeenCalled();
});
it('forbidden WHERE columns never execute or invent zero', async () => {
  const b = backend();
  const request = {
    compute: {
      hidden: { sql: 'SELECT COUNT(*) FROM self.events WHERE userId IS NULL' },
    },
  };
  const read = createAnalyticalSpike(b, association(), parseExpression);
  const result = await read(customers(), request);

  expect(
    result.data.every(
      (r) =>
        !Object.hasOwn(r.data, 'hidden') &&
        r.fields.hidden?.status === 'forbidden',
    ),
  ).toBe(true);
  await expect(
    read(customers(), { ...request, where: { hidden: { eq: '0' } } }),
  ).rejects.toThrow('incomplete');
  expect(b.execute).not.toHaveBeenCalled();
});
it('null/denied correlation never runs an unscoped scan', async () => {
  const b = backend();
  const model = association();

  model.properties.externalId!.readable = false;
  const result = await createAnalyticalSpike(
    b,
    model,
    parseExpression,
  )(customers(), { compute: expressions() });

  expect(result.data[0]!.fields.loginsOct).toEqual({
    status: 'unavailable',
    reason: 'correlation-unavailable',
  });
  expect(b.execute).not.toHaveBeenCalled();
});
it('enforces computed scope at limit+1 before any backend call', async () => {
  const b = backend();
  const read = createAnalyticalSpike(b, association(), parseExpression, {
    scopeLimit: 3,
  });
  const request = {
    compute: { count: { sql: 'SELECT COUNT(*) FROM self.events' } },
    where: { count: { eq: '0' } },
  };

  await read(customers(), request);
  expect(b.execute).toHaveBeenCalledTimes(1);
  await expect(
    read([...customers(), { ...customers()[0]!, id: 'fourth' }], request),
  ).rejects.toThrow('not-supported');
  expect(b.execute).toHaveBeenCalledTimes(1);
});
it('checks missing and conflicting parameters even for an empty candidate set', async () => {
  const b = backend();

  await expect(
    createAnalyticalSpike(
      b,
      association(),
      parseExpression,
    )([], {
      compute: {
        value: {
          sql: 'SELECT COUNT(*) FROM self.events WHERE eventType = $missing',
        },
      },
    }),
  ).rejects.toThrow('invalid-value');
  expect(b.execute).not.toHaveBeenCalled();
});
it('invalid results omit the whole alias, while a different alias survives', async () => {
  const b = backend();

  b.execute = vi.fn(async () => [
    { slot: 0n, v0: 2n, v1: 8n },
    { slot: 1n, v0: 1.5, v1: 9n },
    { slot: 2n, v0: 0n, v1: 0n },
  ]);
  const read = createAnalyticalSpike(b, association(), parseExpression);
  const request = {
    compute: {
      count: { sql: 'SELECT COUNT(*) FROM self.events' },
      other: { sql: 'SELECT COUNT(*) FROM self.events' },
    },
  };
  const result = await read(customers(), request);

  expect(result.data.map((r) => r.data)).toEqual([
    { other: '8' },
    { other: '9' },
    { other: '0' },
  ]);
  await expect(
    read(customers(), {
      ...request,
      orderBy: [{ field: 'count', direction: 'desc' }],
    }),
  ).rejects.toThrow('incomplete');
});
it('statement failures omit all aliases sharing the statement, and required aliases fail the query', async () => {
  const b = backend();

  b.execute = vi.fn(async () => {
    throw new Error('private database error');
  });
  const read = createAnalyticalSpike(b, association(), parseExpression);
  const result = await read(customers(), { compute: expressions() });

  expect(result.data.every((r) => Object.keys(r.data).length === 0)).toBe(true);
  expect(JSON.stringify(result)).not.toContain('private');
  await expect(
    read(customers(), {
      compute: expressions(),
      orderBy: [{ field: 'loginsOct', direction: 'asc' }],
    }),
  ).rejects.toThrow('incomplete');
});
it('orders int64 numerically beyond JS safe integer precision', async () => {
  const b = backend();

  b.execute = vi.fn(async () => [
    { slot: 0n, v0: 9007199254740993n },
    { slot: 1n, v0: 10n },
    { slot: 2n, v0: 2n },
  ]);
  const result = await createAnalyticalSpike(
    b,
    association(),
    parseExpression,
  )(customers(), {
    compute: { count: { sql: 'SELECT COUNT(*) FROM self.events' } },
    orderBy: [{ field: 'count', direction: 'asc' }],
  });

  expect(result.data.map((r) => r.id)).toEqual(['initech', 'globex', 'acme']);
});
it('propagates a late batch failure to the whole alias instead of returning a partial count', async () => {
  const b = backend();

  b.execute = vi
    .fn()
    .mockResolvedValueOnce([{ slot: 0n, v0: 2n }])
    .mockRejectedValueOnce(new Error('outage'))
    .mockResolvedValueOnce([{ slot: 0n, v0: 0n }]);
  const result = await createAnalyticalSpike(
    b,
    association(),
    parseExpression,
    { batchSize: 1 },
  )(customers(), {
    compute: { count: { sql: 'SELECT COUNT(*) FROM self.events' } },
  });

  expect(result.data.every((r) => !Object.hasOwn(r.data, 'count'))).toBe(true);
});
