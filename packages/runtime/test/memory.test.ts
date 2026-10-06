import { expect, it } from 'vitest';
import { compile } from 'relate/compiler';
import { createMemoryStore, createRuntime } from '@relate/runtime';
import {
  Customer,
  customerGraph,
  employee,
  finance,
} from '../../../examples/postgres-persistence/src/model.js';
import { storeContract } from '../../../tests/support/store-contract.js';

storeContract('memory store contract', async () => ({
  store: createMemoryStore(),
  close: async () => {},
}));

it('defaults to isolated memory and supports sharing an explicit store', async () => {
  const options = {
    model: compile(customerGraph),
    graphId: 'memory-test',
    sources: {
      'crm.customers': {
        connectionId: 'test',
        authorization: 'shared-service' as const,
        connector: {
          fetch: async () => ({
            state: 'present' as const,
            record: {
              id: '1',
              display_name: 'Ada',
              organization: 'org_north',
              revenue: 10,
            },
          }),
        },
      },
    },
  };
  const first = createRuntime(options);
  const id = await first.adopt(Customer.id, '1');

  expect(await first.read(employee, Customer.id, id)).toMatchObject({
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
  let now = 1_000;
  let offline = false;
  let name = 'Ada';
  const runtime = createRuntime({
    model: compile(customerGraph),
    graphId: 'memory-fallback',
    clock: () => now,
    sources: {
      'crm.customers': {
        connectionId: 'test',
        authorization: 'shared-service',
        connector: {
          async fetch() {
            if (offline) throw new Error('offline');

            return {
              state: 'present',
              record: {
                id: '1',
                display_name: name,
                organization: 'org_north',
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
  expect(
    await runtime.read(employee, Customer.id, id, {
      select: ['revenue'],
    }),
  ).toMatchObject({
    data: {},
    meta: { fields: { revenue: { status: 'unavailable' } } },
  });
  name = 'Grace';
  now += 1_000;
  expect(
    await runtime.read(finance, Customer.id, id, { refresh: true }),
  ).toMatchObject({ data: { name: 'Grace', revenue: 10 } });
  offline = true;
  now += 1_000;
  expect(
    await runtime.read(employee, Customer.id, id, { maxAgeMs: 0 }),
  ).toMatchObject({
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
