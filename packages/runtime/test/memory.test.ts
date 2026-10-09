import { expect, it } from 'vitest';
import { compile } from 'relate/compiler';
import { createMemoryStore, createRuntime } from '@relate/runtime';
import { assertFields } from 'relate';
import { ReadError } from '@relate/protocol';
import { createCustomerGraph } from '../../../tests/support/customer-graph.js';
import { storeContract } from '../../../tests/support/store-contract.js';

storeContract('memory store contract', async () => ({
  store: createMemoryStore(),
  close: async () => {},
}));

it('defaults to isolated memory and supports sharing an explicit store', async () => {
  const { Customer, customerGraph, employee } = createCustomerGraph();

  const options = {
    model: compile(customerGraph),
    graphId: 'memory-test',
    sources: {
      'crm.customers': {
        providerAccountId: 'example-account',
        connectionId: 'test',
        authorization: 'shared-service' as const,
        connector: {
          identify: async () => 'example-account',
          fetch: async () => ({
            providerAccountId: 'example-account',
            state: 'present' as const,
            record: {
              id: '1',
              display_name: 'Ada',
              portfolio: 'portfolio_north',
              revenue: 10,
            },
          }),
        },
      },
    },
  };
  const first = createRuntime(options);
  const id = await first.adopt(Customer.id, '1');

  expect(
    await first.read(employee, Customer.id, id, { evidence: 'full' }),
  ).toMatchObject({
    status: 'ok',
    data: { id, name: 'Ada' },
    meta: {
      fields: {
        name: { retention: 'confirmed', retentionDurability: 'volatile' },
      },
    },
  });
  expect(await createRuntime(options).read(employee, Customer.id, id)).toEqual({
    status: 'not-found',
  });
  const store = createMemoryStore();
  const sharedId = await createRuntime({ ...options, store }).adopt(
    Customer.id,
    '1',
  );

  expect(
    await createRuntime({ ...options, store }).read(
      employee,
      Customer.id,
      sharedId,
    ),
  ).toMatchObject({ status: 'ok', data: { id: sharedId } });
});

it('enforces authorization, refresh and expired permission during memory fallback', async () => {
  const { Customer, customerGraph, employee, finance } = createCustomerGraph();

  let now = 1_000;
  let offline = false;
  let name = 'Ada';
  const runtime = createRuntime({
    model: compile(customerGraph),
    graphId: 'memory-fallback',
    clock: () => now,
    sources: {
      'crm.customers': {
        providerAccountId: 'example-account',
        connectionId: 'test',
        authorization: 'shared-service',
        connector: {
          identify: async () => 'example-account',
          async fetch() {
            if (offline) throw new Error('offline');

            return {
              providerAccountId: 'example-account',
              state: 'present',
              record: {
                id: '1',
                display_name: name,
                portfolio: 'portfolio_north',
                revenue: 10,
              },
            };
          },
        },
      },
    },
  });
  const id = await runtime.adopt(Customer.id, '1');

  expect(
    await runtime.read({ ...employee, roles: [] }, Customer.id, id),
  ).toEqual({ status: 'not-found' });
  const hidden = await runtime.read(employee, Customer.id, id, {
    select: ['revenue'],
  });

  expect(hidden).toMatchObject({
    data: {},
    meta: { fields: { revenue: { status: 'forbidden' } } },
  });
  expect(() => assertFields(hidden, ['revenue'])).toThrow(
    new ReadError('incomplete'),
  );
  name = 'Grace';
  now += 1_000;
  expect(
    await runtime.read(finance, Customer.id, id, { refresh: true }),
  ).toMatchObject({ data: { name: 'Grace', revenue: 10 } });
  offline = true;
  now += 1_000;
  const fallback = await runtime.read(employee, Customer.id, id, {
    maxAgeMs: 0,
  });

  assertFields(fallback, ['name']);
  expect(fallback).toMatchObject({
    data: { name: 'Grace' },
    meta: {
      fields: {
        name: {
          freshness: 'stale',
          refresh: 'unavailable',
          retention: 'confirmed',
          retentionDurability: 'volatile',
        },
      },
    },
  });
  now += 30_001;
  expect(await runtime.read(employee, Customer.id, id)).toEqual({
    status: 'not-found',
  });
});
