import { afterEach, expect, it } from 'vitest';
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
import type { PreparedPlan, AuthorizedDatasetQuery } from 'relate/connectors';
import { createAnalyticalGraph } from '../../../tests/support/analytical-graph.js';
import {
  createAnalyticalConnector,
  analyticalGraphSchema,
} from '../../../tests/support/analytical-connector.js';

const cleanup: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const close of cleanup.splice(0)) await close();
});

it.each(['same', 'changed', 'unavailable'] as const)(
  'revalidates source correlation when its policy evidence expires: %s',
  async (change) => {
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
        rows: plans.get(plan)!.slots.map((_, slot) => ({ slot, values: [7n] })),
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

    cleanup.push(() => runtime.close());
    const id = await runtime.host.adopt(Customer, 'one');
    const result = await runtime
      .as({ id: 'ana', roles: ['reader', 'analyst'], claims: {} })
      .objects.Customer.get(id, {
        select: ['name', 'count'],
        evidence: 'full',
        maxAgeMs: 100000,
        stale: 'omit',
      });

    expect(result.status).toBe('ok');

    if (result.status !== 'ok') return;

    expect(statements).toBe(1);
    expect(fetches).toBe(2);
    expect(result.data.name).toBe('Acme');
    expect(result.data).not.toHaveProperty('externalId');

    if (change === 'same') {
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
