import { assertFields, referenceInput } from 'relate';
import { expect, it, vi } from 'vitest';
import { createRuntime, connect } from '@relate/node';
import { createMemoryStore, SourceAccessDenied } from '@relate/runtime';
import { graph, Customer, customers, ana, finance } from './model.js';

function fixture() {
  let now = 1_000;
  let state: 'present' | 'offline' | 'forbidden' | 'deleted' = 'present';
  let calls = 0;
  const relate = createRuntime({
    graph,
    clock: () => now,
    connections: [
      connect(customers, {
        connectionId: 'crm-primary',
        connector: {
          async fetch(id) {
            calls++;

            if (state === 'offline') throw new Error('Temporary outage');

            if (state === 'forbidden') throw new SourceAccessDenied();

            if (state === 'deleted') return { state: 'deleted' };

            return {
              state: 'present',
              record: {
                id,
                name: 'Northwind',
                portfolio: 'north',
                revenue: 250_000,
              },
            };
          },
        },
      }),
    ],
  });

  return {
    relate,
    calls: () => calls,
    advance: (ms: number) => {
      now += ms;
    },
    setState: (value: typeof state) => {
      state = value;
    },
  };
}

it('adopts once and reads selected fields through a principal-bound object', async () => {
  const relate = createRuntime({
    graph,
    connections: [
      connect(customers, {
        connectionId: 'crm-primary',
        connector: {
          async fetch(id) {
            return {
              state: 'present',
              record: {
                id,
                name: 'Northwind',
                portfolio: 'north',
                revenue: 250_000,
              },
            };
          },
        },
      }),
    ],
  });

  try {
    const id = await relate.host.adopt(Customer, 'crm_456');

    expect(id).not.toBe('crm_456');
    expect(await relate.host.adopt(Customer, 'crm_456')).toBe(id);
    expect(
      await relate.as(ana).objects.Customer.get(id, {
        select: ['name', 'revenue'],
      }),
    ).toMatchObject({
      status: 'ok',
      id,
      data: { name: 'Northwind' },
      meta: {
        completeness: 'partial',
        fields: {
          name: { status: 'available', retentionDurability: 'volatile' },
          revenue: { status: 'unavailable' },
        },
      },
    });
  } finally {
    await relate.close();
  }
});

it('grants financial fields only within the caller portfolio and never leaks hidden values', async () => {
  const { relate } = fixture();
  const id = await relate.host.adopt(Customer, 'crm_456');
  const hidden = await relate
    .as(ana)
    .objects.Customer.get(id, { select: ['name', 'revenue'] });

  expect(hidden.status).toBe('ok');

  if (hidden.status !== 'ok') throw new Error('Expected customer');

  expect(hidden.data).toEqual({ name: 'Northwind' });
  expect(() => assertFields(hidden, ['revenue'])).toThrow('incomplete');
  const visible = await relate
    .as(finance)
    .objects.Customer.get(id, { select: ['name', 'revenue'] });

  expect(visible).toMatchObject({
    data: { name: 'Northwind', revenue: 250_000 },
    meta: { completeness: 'complete' },
  });
  expect(
    await relate
      .as({ ...finance, claims: { portfolio: 'south' } })
      .objects.Customer.get(id),
  ).toEqual({ status: 'not-found' });
  expect(
    await relate.as({ ...ana, claims: {} }).objects.Customer.get(id),
  ).toEqual({ status: 'not-found' });
  expect(
    await relate.as({ ...ana, roles: [] }).objects.Customer.get(id),
  ).toEqual({
    status: 'not-found',
  });
  await relate.close();
});

it('never adopts or contacts the source when reading unknown IDs', async () => {
  const { relate, calls } = fixture();

  expect(
    await relate
      .as(ana)
      .objects.Customer.get(referenceInput(Customer).parse('crm_456')),
  ).toEqual({
    status: 'not-found',
  });
  expect(calls()).toBe(0);
  await relate.close();
});

it('keeps authorized stale values and their evidence, but cannot renew expired permission', async () => {
  const { relate, advance, setState } = fixture();
  const id = await relate.host.adopt(Customer, 'crm_456');

  setState('offline');
  advance(2_000);
  const result = await relate
    .as(ana)
    .objects.Customer.get(id, { select: ['name'], maxAgeMs: 1_000 });

  assertFields(result, ['name']);
  expect(result.data).toEqual({ name: 'Northwind' });
  expect(result.meta).toMatchObject({
    degraded: true,
    fields: {
      name: {
        freshness: 'stale',
        refresh: 'unavailable',
        retention: 'confirmed',
        observedAt: new Date(1_000).toISOString(),
      },
    },
  });
  advance(30_000);
  expect(await relate.as(ana).objects.Customer.get(id)).toEqual({
    status: 'not-found',
  });
  await relate.close();
});

it.each(['forbidden', 'deleted'] as const)(
  'withholds cached values when the provider reports %s',
  async (state) => {
    const { relate, setState } = fixture();
    const id = await relate.host.adopt(Customer, 'crm_456');

    setState(state);
    expect(
      await relate
        .as(ana)
        .objects.Customer.get(id, { select: ['name'], refresh: true }),
    ).toEqual({ status: 'not-found' });
    await relate.close();
  },
);

it('binds an authenticated principal snapshot and keeps ingestion off the consumer', async () => {
  const { relate } = fixture();
  const id = await relate.host.adopt(Customer, 'crm_456');
  const principal = structuredClone(ana);
  const consumer = relate.as(principal);

  principal.roles.push('finance');
  principal.claims.portfolio = 'south';
  expect(consumer).not.toHaveProperty('host');
  expect(
    await consumer.objects.Customer.get(id, { select: ['name', 'revenue'] }),
  ).toMatchObject({
    data: { name: 'Northwind' },
    meta: { fields: { revenue: { status: 'unavailable' } } },
  });
  await relate.close();
  await expect(consumer.objects.Customer.get(id)).rejects.toThrow('closed');
  await expect(relate.host.adopt(Customer, 'crm_456')).rejects.toThrow(
    'closed',
  );
});

it('validates registration before use instead of trusting structurally similar definitions', async () => {
  expect(() => createRuntime({ graph, connections: [] })).toThrow(
    'source binding',
  );
  const binding = {
    connectionId: 'crm',
    connector: { fetch: async () => ({ state: 'deleted' as const }) },
  };
  const connection = connect(customers, binding);

  expect(() =>
    createRuntime({ graph, connections: [connection, connection] }),
  ).toThrow('Duplicate');
  expect(() =>
    createRuntime({ graph, connections: [connect({ ...customers }, binding)] }),
  ).toThrow('Unregistered');
  const { relate } = fixture();

  await expect(relate.host.adopt({ ...Customer }, 'crm_456')).rejects.toThrow(
    'Unregistered',
  );
  await relate.close();
});

it('waits for an in-flight read at close and leaves borrowed storage usable', async () => {
  const borrowedClose = vi.fn();
  const store = { ...createMemoryStore(), close: borrowedClose };
  let release!: () => void;
  let started!: () => void;
  const waiting = new Promise<void>((resolve) => {
    started = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let block = false;
  const connections = [
    connect(customers, {
      connectionId: 'crm',
      connector: {
        async fetch(id) {
          if (block) {
            started();
            await gate;
          }

          return {
            state: 'present',
            record: {
              id,
              name: 'Northwind',
              portfolio: 'north',
              revenue: 250_000,
            },
          };
        },
      },
    }),
  ];
  const relate = createRuntime({ graph, connections, store });
  const id = await relate.host.adopt(Customer, 'crm_456');

  block = true;
  const consumer = relate.as(ana);
  const pending = consumer.objects.Customer.get(id, { refresh: true });

  await waiting;
  let closed = false;
  const closing = relate.close().then(() => {
    closed = true;
  });

  await expect(consumer.objects.Customer.get(id)).rejects.toThrow('closed');
  expect(closed).toBe(false);
  release();
  expect(await pending).toMatchObject({ status: 'ok', id });
  await closing;
  expect(borrowedClose).not.toHaveBeenCalled();
  const next = createRuntime({ graph, connections, store });

  expect(await next.as(ana).objects.Customer.get(id)).toMatchObject({
    status: 'ok',
    id,
  });
  await next.close();
});

it('denies objects with no policy even when they have been adopted', async () => {
  const relate = createRuntime({
    graph: { ...graph, policies: { Customer: { read: 'deny' } } },
    connections: [
      connect(customers, {
        connectionId: 'crm',
        connector: {
          async fetch(id) {
            return {
              state: 'present',
              record: {
                id,
                name: 'Northwind',
                portfolio: 'north',
                revenue: 250_000,
              },
            };
          },
        },
      }),
    ],
  });
  const id = await relate.host.adopt(Customer, 'crm_456');

  expect(await relate.as(finance).objects.Customer.get(id)).toEqual({
    status: 'not-found',
  });
  await relate.close();
});
