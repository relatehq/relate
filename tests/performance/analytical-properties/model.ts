import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
import {
  bind,
  defineAccess,
  defineGraph,
  defineDataset,
  defineApp,
  defineObject,
  defineSource,
  from,
  objectId,
  source,
} from 'relate';
import { startApp } from '@relate/node';
import type { AnalyticalResource } from 'relate/connectors';
import type { ObservationStore } from 'relate/storage';
import type { Trace } from './timing.js';

export interface Customer {
  key: string;
  name: string;
  portfolio: string;
}

export interface Event {
  customer: string;
  type: string;
  at: string;
}

export interface Values {
  loginCount: string;
  lastLogin: string | null;
}

export interface Row {
  id: string;
  data: { name: string } & Partial<Values>;
}

export const since = '2026-10-01T00:00:00.000Z';
export const until = '2026-11-01T00:00:00.000Z';

/** Benchmark-owned workload contract: deliberately separate from createCustomerGraph.
 * That fixture includes finance/revenue and 30-second policy evidence. This one
 * needs an explicit correlation key and day-long evidence so elapsed benchmark
 * time cannot introduce source refreshes. Evolve it only with workloadVersion.
 */
export function createModel() {
  const access = defineAccess({
    roles: ['employee'],
    fieldGroups: ['ordinary'],
    claims: { portfolio: z.string() },
  });
  const customers = defineSource({
    id: 'benchmark.customers',
    idField: 'key',
    schema: z.object({
      key: z.string(),
      name: z.string(),
      portfolio: z.string(),
    }),
  });
  const Events = defineDataset({
    id: 'benchmark.events',
    columns: {
      customer: {
        id: 'benchmark.event.customer',
        schema: z.string(),
        access: access.groups.ordinary,
      },
      eventType: {
        id: 'benchmark.event.type',
        schema: z.string(),
        access: access.groups.ordinary,
      },
      occurredAt: {
        id: 'benchmark.event.at',
        schema: z.iso.datetime({ offset: true, precision: 3 }),
        access: access.groups.ordinary,
      },
    },
  });
  const Customer = defineObject({
    id: 'benchmark.customer',
    membership: source(customers),
    datasets: {
      events: {
        id: 'benchmark.customer.events',
        dataset: Events,
        on: [{ column: 'customer', property: 'key' }],
      },
    },
    properties: {
      id: objectId({ id: 'benchmark.customer.id' }),
      key: from(customers.fields.key, { id: 'benchmark.customer.key' }),
      name: from(customers.fields.name, { id: 'benchmark.customer.name' }),
      portfolio: from(customers.fields.portfolio, {
        id: 'benchmark.customer.portfolio',
      }),
    },
  });
  const graph = defineGraph({
    id: 'benchmark.graph',
    objects: { Customer },
    datasets: { Events },
    access,
    policies: {
      Events: {},
      Customer: {
        datasets: { events: { gate: access.role('employee') } },
        read: {
          gate: access.role('employee'),
          evidenceMaxAgeMs: 86400000,
          where: { portfolio: { eq: access.claims.portfolio } },
        },
      },
    },
  });

  return { Customer, customers, Events, graph };
}

export interface ObjectOptions {
  graphId: string;
  store: ObservationStore;
  resource: AnalyticalResource;
  capture: 'enabled' | 'disabled';
  freshness: 'cached' | 'refresh';
  sourceDelayMs: number;
}

export async function openObjects(records: Customer[], options: ObjectOptions) {
  const model = createModel();
  const byKey = new Map(records.map((row) => [row.key, row]));
  let active: Trace | undefined;
  let now = Date.now();
  const count = (name: string, amount = 1) => {
    if (active) active.counters[name] = (active.counters[name] ?? 0) + amount;
  };
  const underlying = options.store;
  const store: ObservationStore = {
    ...underlying,
    async scan(...args) {
      count('membershipScans');
      const result = await underlying.scan(...args);

      count('candidatesScanned', result.objects.length);

      return result;
    },
    async load(...args) {
      count('objectLoads');

      return underlying.load(...args);
    },
    async resolve(...args) {
      count('sourceResolutions');

      return underlying.resolve(...args);
    },
    ...(underlying.activity
      ? {
          activity: {
            ...underlying.activity,
            async appendOperations(graphId, drafts) {
              for (const draft of drafts)
                if (draft.kind === 'query') {
                  count('capturedOperations');

                  if (draft.details.analytical)
                    active?.addTimings(draft.details.analytical);
                }

              return underlying.activity!.appendOperations(graphId, drafts);
            },
          },
        }
      : {}),
  };
  const analytics = options.resource.connection.analytics;
  const resource: AnalyticalResource = {
    ...options.resource,
    connection: {
      ...options.resource.connection,
      analytics: {
        ...analytics,
        plan(query) {
          count('analyticalBatches');
          count('computedSlots', query.slots.length);

          return analytics.plan(query);
        },
        execute(plan, request) {
          count('analyticalStatements');

          return analytics.execute(plan, request);
        },
      },
    },
  };
  const app = await startApp(
    defineApp({
      graph: model.graph,
      setup: () => ({
        graphId: options.graphId,
        store,
        clock: () => now,
        activity: { operations: options.capture },
        bindings: [
          bind(model.Events, resource, {
            columns: { eventType: 'type', occurredAt: 'at' },
          }),
          bind(model.customers, {
            connectionId: 'benchmark',
            resourceId: 'customers',
            providerAccountId: 'synthetic',
            connector: {
              identify: async () => 'synthetic',
              fetch: async (key, { signal }) => {
                count('sourceFetches');

                if (active && options.sourceDelayMs)
                  await delay(options.sourceDelayMs, undefined, { signal });

                const record = byKey.get(key);

                if (!record)
                  throw new Error(`Missing benchmark customer ${key}`);

                return {
                  state: 'present',
                  providerAccountId: 'synthetic',
                  record: { ...record },
                };
              },
            },
          }),
        ],
      }),
    }),
  );
  const ids = new Map<string, string>();

  try {
    for (const row of records)
      ids.set(row.key, await app.host.adopt(model.Customer, row.key));

    if ((await app.host.flushActivity()) !== 'flushed')
      throw new Error('Setup activity did not drain');
  } catch (error) {
    await app.close();
    throw error;
  }

  return {
    app,
    ids,
    begin(trace: Trace) {
      if (active)
        throw new Error('Benchmark requests must be sequential and settled');

      active = trace;

      for (const name of [
        'membershipScans',
        'candidatesScanned',
        'objectLoads',
        'sourceResolutions',
        'sourceFetches',
        'analyticalBatches',
        'analyticalStatements',
        'computedSlots',
        'capturedOperations',
      ])
        trace.counters[name] = 0;

      if (options.freshness === 'refresh') now += 2 * 86400000;

      const dropped = Object.values(app.host.activityCounters().dropped).reduce(
        (a, b) => a + b,
        0,
      );

      trace.settle = async () => {
        try {
          if ((await app.host.flushActivity()) !== 'flushed')
            throw new Error('Benchmark activity did not drain');

          const after = Object.values(
            app.host.activityCounters().dropped,
          ).reduce((a, b) => a + b, 0);

          trace.counters.activityDrops = after - dropped;

          if (after !== dropped)
            throw new Error('Benchmark activity capture dropped operations');
        } finally {
          active = undefined;
        }
      };
    },
    customer: app.as({
      id: 'benchmark-reader',
      roles: ['employee'],
      claims: { portfolio: 'north' },
    }).objects.Customer,
  };
}
