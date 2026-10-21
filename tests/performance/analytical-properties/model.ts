import { z } from 'zod';
import {
  connect,
  defineAccess,
  defineGraph,
  defineObject,
  defineSource,
  from,
  objectId,
  source,
} from 'relate';
import { createRuntime } from '@relate/node';
import { createMemoryStore } from '@relate/runtime';

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
  const Customer = defineObject({
    id: 'benchmark.customer',
    membership: source(customers),
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
    access,
    policies: {
      Customer: {
        read: {
          gate: access.role('employee'),
          evidenceMaxAgeMs: 86400000,
          where: { portfolio: { eq: access.claims.portfolio } },
        },
      },
    },
  });

  return { Customer, customers, graph };
}

export async function openObjects(records: Customer[]) {
  const model = createModel();
  const byKey = new Map(records.map((row) => [row.key, row]));
  let sourceFetches = 0;
  const app = createRuntime({
    graph: model.graph,
    graphId: 'analytical-benchmark',
    store: createMemoryStore(),
    connections: [
      connect(model.customers, {
        connectionId: 'benchmark',
        providerAccountId: 'synthetic',
        connector: {
          identify: async () => 'synthetic',
          fetch: async (key) => {
            sourceFetches++;
            const record = byKey.get(key);

            if (!record) throw new Error(`Missing benchmark customer ${key}`);

            return {
              state: 'present',
              providerAccountId: 'synthetic',
              record: { ...record },
            };
          },
        },
      }),
    ],
  });
  const ids = new Map<string, string>();

  try {
    for (const row of records)
      ids.set(row.key, await app.host.adopt(model.Customer, row.key));
  } catch (error) {
    await app.close();
    throw error;
  }

  return {
    app,
    ids,
    sourceFetches: () => sourceFetches,
    customer: app.as({
      id: 'benchmark-reader',
      roles: ['employee'],
      claims: { portfolio: 'north' },
    }).objects.Customer,
  };
}
