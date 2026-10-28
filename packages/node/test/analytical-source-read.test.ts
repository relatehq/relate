import { onTestFinished, expect, it } from 'vitest';
import { z } from 'zod';
import {
  bind,
  computed,
  defineApp,
  defineGraph,
  defineObject,
  defineSource,
  from,
  source,
  objectId,
} from 'relate';
import { startApp } from '@relate/node';
import { createMemoryStore } from '@relate/runtime';
import type { ObservationStore } from '@relate/runtime/storage';
import type { PreparedPlan, AuthorizedDatasetQuery } from 'relate/connectors';
import { createAnalyticalGraph } from '../../../tests/support/analytical-graph.js';
import {
  createAnalyticalConnector,
  analyticalGraphSchema,
} from '../../../tests/support/analytical-connector.js';

it.each(
  (['get', 'query'] as const).flatMap((mode) =>
    (['same', 'changed', 'unavailable', 'advancing'] as const).map(
      (change) => [mode, change] as const,
    ),
  ),
)(
  '%s revalidates source correlation when its policy evidence expires: %s',
  async (mode, change) => {
    const { graph: base, Events } = createAnalyticalGraph();
    const access = base.access;
    const customers = defineSource({
      id: 'customers',
      idField: 'id',
      schema: z.object({
        id: z.string(),
        externalId: z.string(),
        name: z.string(),
      }),
    });
    const Customer = defineObject({
      id: 'customer',
      membership: source(customers),
      properties: {
        id: objectId({ id: 'customer.id' }),
        externalId: from(customers.fields.externalId, {
          id: 'customer.external',
        }),
        name: from(customers.fields.name, { id: 'customer.name' }),
        count: computed({
          id: 'customer.count',
          sql: 'SELECT COUNT(*) FROM self.events',
        }),
      },
      datasets: {
        events: {
          id: 'customer.events',
          dataset: Events,
          on: [{ column: 'customerId', property: 'externalId' }],
        },
      },
    });
    const graph = defineGraph({
      id: 'source-analytics',
      access,
      objects: { Customer },
      datasets: { Events },
      policies: {
        Customer: {
          read: { gate: access.role('reader') },
          datasets: { events: { gate: access.role('analyst') } },
        },
        Events: { groups: { private: access.role('private') } },
      },
    });
    const analytical = createAnalyticalConnector(analyticalGraphSchema());
    const plans = new WeakMap<PreparedPlan, AuthorizedDatasetQuery>();
    let now = 0;
    let statements = 0;
    let fetches = 0;

    analytical.connection.analytics.plan = (query) => {
      const plan = {} as PreparedPlan;

      plans.set(plan, query);

      return plan;
    };
    analytical.connection.analytics.execute = async (plan) => {
      statements++;
      now = 61000;

      return {
        readAt: '1970-01-01T00:00:00.000Z',
        rows: plans.get(plan)!.slots.map((_, slot) => ({
          slot,
          values: [7n],
          checks: [{ arithmeticFailed: false }],
        })),
      };
    };
    const runtime = await startApp(
      defineApp({
        graph,
        setup() {
          return {
            clock: () => now,
            bindings: [
              bind(Events, analytical.table('events')),
              bind(customers, {
                connectionId: 'crm',
                resourceId: 'customers',
                connector: {
                  identity: 'application',
                  async fetch() {
                    fetches++;

                    if (change === 'advancing') now++;

                    if (statements && change === 'unavailable')
                      throw new Error('offline');

                    return {
                      state: 'present',
                      record: {
                        id: 'one',
                        externalId:
                          statements && change === 'changed'
                            ? 'different'
                            : 'acme',
                        name: 'Acme',
                      },
                    };
                  },
                },
              }),
            ],
          };
        },
      }),
    );

    onTestFinished(() => runtime.close());
    const id = await runtime.host.adopt(Customer, 'one');
    const consumer = runtime.as({
      id: 'ana',
      roles: ['reader', 'analyst'],
      claims: {},
    }).objects.Customer;
    const request = {
      select: ['name', 'count'],
      evidence: 'full',
      maxAgeMs: 100000,
      stale: 'omit',
    } as const;
    const page = mode === 'query' ? await consumer.query(request) : undefined;
    const result = page
      ? page.data[0]
        ? { status: 'ok' as const, ...page.data[0] }
        : { status: 'not-found' as const }
      : await consumer.get(id, request);

    expect(result.status).toBe('ok');

    if (result.status !== 'ok') return;

    expect(statements).toBe(1);
    expect(fetches).toBe(2);
    expect(result.data.name).toBe('Acme');
    expect(result.data).not.toHaveProperty('externalId');

    if (change === 'same' || change === 'advancing') {
      expect(result.data.count).toBe('7');
      expect(result.meta.fields.count).toMatchObject({
        dependencies: {
          externalId: { observedAt: '1970-01-01T00:01:01.000Z' },
        },
      });
    } else {
      expect(result.data).not.toHaveProperty('count');
      expect(result.meta.fields.count).toEqual({
        status: 'unavailable',
        reason: 'correlation-unavailable',
      });
    }
  },
);

it('keeps each candidate read time across a scan longer than its freshness bound', async () => {
  const base = createAnalyticalGraph();
  const customers = defineSource({
    id: 'crm-customers',
    idField: 'id',
    schema: z.object({ id: z.string(), externalId: z.string() }),
  });
  const Customer = defineObject({
    ...base.Customer,
    membership: source(customers),
    properties: {
      id: objectId({ id: 'customer.id' }),
      externalId: from(customers.fields.externalId, {
        id: 'customer.external',
      }),
      count: base.Customer.properties.count,
    },
  });
  const graph = defineGraph({ ...base.graph, objects: { Customer } });
  const connector = createAnalyticalConnector(analyticalGraphSchema());
  const plans = new WeakMap<PreparedPlan, AuthorizedDatasetQuery>();
  let now = 0,
    measured = false,
    planned = 0,
    active = 0,
    peak = 0;

  connector.connection.analytics.plan = (query) => {
    const handle = {} as PreparedPlan;

    plans.set(handle, query);
    planned += query.slots.length;

    return handle;
  };
  connector.connection.analytics.execute = async (handle) => ({
    readAt: new Date(now).toISOString(),
    rows: plans.get(handle)!.slots.map((_, slot) => ({
      slot,
      values: [1n],
      checks: [{ arithmeticFailed: false }],
    })),
  });
  const runtime = await startApp(
    defineApp({
      graph,
      setup: () => ({
        clock: () => now,
        bindings: [
          bind(base.Events, connector.table('events')),
          bind(customers, {
            connectionId: 'crm',
            resourceId: 'customers',
            connector: {
              identity: 'application',
              async fetch(id) {
                if (measured) now += 1000;

                if (planned) {
                  peak = Math.max(peak, ++active);
                  await new Promise<void>((resolve) => setImmediate(resolve));
                  active--;
                }

                return { state: 'present', record: { id, externalId: id } };
              },
            },
          }),
        ],
      }),
    }),
  );

  onTestFinished(() => runtime.close());

  for (let i = 0; i < 120; i++) await runtime.host.adopt(Customer, String(i));

  measured = true;
  const page = await runtime
    .as({ id: 'ana', roles: ['reader', 'analyst', 'private'], claims: {} })
    .objects.Customer.query({
      select: ['count'],
      maxAgeMs: 10000,
      refresh: true,
      stale: 'omit',
      orderBy: [{ field: 'count', direction: 'desc' }],
      limit: 25,
    });

  expect(now).toBeGreaterThan(10000);
  expect(planned).toBe(120);
  expect(peak).toBeGreaterThan(1);
  expect(peak).toBeLessThanOrEqual(8);
  expect(page.data).toHaveLength(25);
  expect(page.data.every((row) => row.data.count === '1')).toBe(true);
});

it('reads scanned candidates from their scan and batches revalidation loads', async () => {
  const base = createAnalyticalGraph();
  const customers = defineSource({
    id: 'crm-customers',
    idField: 'id',
    schema: z.object({ id: z.string(), externalId: z.string() }),
  });
  const Customer = defineObject({
    ...base.Customer,
    membership: source(customers),
    properties: {
      id: objectId({ id: 'customer.id' }),
      externalId: from(customers.fields.externalId, {
        id: 'customer.external',
      }),
      count: base.Customer.properties.count,
    },
  });
  const graph = defineGraph({ ...base.graph, objects: { Customer } });
  const connector = createAnalyticalConnector(analyticalGraphSchema());
  const plans = new WeakMap<PreparedPlan, AuthorizedDatasetQuery>();
  const backing = createMemoryStore();
  const calls = { load: 0, loadMany: [] as number[] };
  const store: ObservationStore = {
    ...backing,
    load: (...args) => {
      calls.load++;

      return backing.load(...args);
    },
    loadMany: (scope, ids) => {
      calls.loadMany.push(ids.length);

      return backing.loadMany(scope, ids);
    },
  };

  connector.connection.analytics.plan = (query) => {
    const handle = {} as PreparedPlan;

    plans.set(handle, query);

    return handle;
  };
  connector.connection.analytics.execute = async (handle) => ({
    readAt: new Date(0).toISOString(),
    rows: plans.get(handle)!.slots.map((_, slot) => ({
      slot,
      values: [BigInt(slot)],
      checks: [{ arithmeticFailed: false }],
    })),
  });
  const runtime = await startApp(
    defineApp({
      graph,
      setup: () => ({
        store,
        clock: () => 0,
        bindings: [
          bind(base.Events, connector.table('events')),
          bind(customers, {
            connectionId: 'crm',
            resourceId: 'customers',
            connector: {
              identity: 'application',
              async fetch(id) {
                return { state: 'present', record: { id, externalId: id } };
              },
            },
          }),
        ],
      }),
    }),
  );

  onTestFinished(() => runtime.close());

  for (let i = 0; i < 120; i++) await runtime.host.adopt(Customer, String(i));

  const consumer = runtime.as({
    id: 'ana',
    roles: ['reader', 'analyst', 'private'],
    claims: {},
  }).objects.Customer;

  calls.load = 0;
  calls.loadMany = [];
  const listed = await consumer.query({ select: ['externalId'], limit: 50 });

  expect(listed.data).toHaveLength(50);
  expect(calls).toEqual({ load: 0, loadMany: [] });

  const ranked = await consumer.query({
    select: ['count'],
    orderBy: [{ field: 'count', direction: 'desc' }],
    limit: 25,
  });

  expect(ranked.data).toHaveLength(25);
  // 120 candidates revalidated in batches of 100, then the 25 chosen rows.
  expect(calls).toEqual({ load: 0, loadMany: [100, 20, 25] });
});
