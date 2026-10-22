import { onTestFinished, expect, it } from 'vitest';
import { z } from 'zod';
import {
  bind,
  computed,
  defineApp,
  defineAccess,
  defineGraph,
  defineObject,
  defineSource,
  from,
  objectId,
  reference,
  source,
} from 'relate';
import type { AnalyticalLimits } from 'relate/analytics';
import type {
  AuthorizedDatasetQuery,
  PreparedPlan,
  ApplicationSourceRecord,
} from 'relate/connectors';
import { startApp } from '@relate/node';
import { createAnalyticalGraph } from '../../../tests/support/analytical-graph.js';
import {
  analyticalGraphSchema,
  createAnalyticalConnector,
} from '../../../tests/support/analytical-connector.js';

async function app(options: {
  limits: AnalyticalLimits;
  activity?: 'enabled' | 'disabled';
  provider?: boolean;
  nested?: boolean;
  onDispose?: () => void;
}) {
  const { Events } = createAnalyticalGraph();
  const access = defineAccess({
    roles: ['reader', 'analyst', 'private'],
    fieldGroups: ['ordinary', 'private'],
    claims: { ownerName: z.string() },
  });
  const owners = defineSource({
    id: 'owners',
    idField: 'id',
    schema: z.object({ id: z.string(), name: z.string() }),
  });
  const Owner = defineObject({
    id: 'owner',
    membership: source(owners),
    properties: {
      id: objectId({ id: 'owner.id' }),
      name: from(owners.fields.name, { id: 'owner.name' }),
    },
  });
  const customers = defineSource({
    id: 'customers',
    idField: 'id',
    schema: z.object({
      id: z.string(),
      externalId: z.string(),
      owner: z.string(),
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
      owner: reference(Owner, {
        id: 'customer.owner',
        from: customers.fields.owner,
      }),
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
    id: 'analytical-budgets',
    access,
    objects: { Customer, Owner },
    datasets: { Events },
    policies: {
      Customer: {
        read: options.nested
          ? {
              gate: access.role('reader'),
              where: { owner: { name: { eq: access.claims.ownerName } } },
              evidenceMaxAgeMs: 60_000,
            }
          : { gate: access.role('reader') },
        datasets: { events: { gate: access.role('analyst') } },
      },
      Owner: { read: { gate: access.role('reader') } },
      Events: { groups: { private: access.role('private') } },
    },
  });
  const counters = {
    fetches: 0,
    identities: 0,
    ownerFetches: 0,
    statements: 0,
  };
  const hooks: {
    fetch?: (signal: AbortSignal) => Promise<ApplicationSourceRecord>;
    identify?: (signal: AbortSignal) => Promise<string>;
    execute?: () => void;
  } = {};
  let now = 0;
  const analytical = createAnalyticalConnector(analyticalGraphSchema());
  const plans = new WeakMap<PreparedPlan, AuthorizedDatasetQuery>();

  analytical.connection.analytics.plan = (query) => {
    const plan = {} as PreparedPlan;

    plans.set(plan, query);

    return plan;
  };
  analytical.connection.analytics.execute = async (plan) => {
    counters.statements++;
    hooks.execute?.();

    return {
      readAt: new Date(now).toISOString(),
      rows: plans.get(plan)!.slots.map((_, slot) => ({ slot, values: [7n] })),
    };
  };
  const fetch = async (id: string, { signal }: { signal: AbortSignal }) => {
    counters.fetches++;

    if (hooks.fetch) return hooks.fetch(signal);

    return {
      state: 'present' as const,
      record: { id, externalId: 'acme', owner: 'owner-one' },
    };
  };
  const resource = {
    connectionId: 'crm',
    resourceId: 'customers',
    ...(options.provider
      ? {
          providerAccountId: 'account',
          connector: {
            identity: 'provider' as const,
            async identify({ signal }: { signal: AbortSignal }) {
              counters.identities++;

              return hooks.identify ? hooks.identify(signal) : 'account';
            },
            async fetch(...args: Parameters<typeof fetch>) {
              return {
                ...(await fetch(...args)),
                providerAccountId: 'account',
              };
            },
          },
        }
      : { connector: { identity: 'application' as const, fetch } }),
  };
  const runtime = await startApp(
    defineApp({
      graph,
      setup({ onDispose }) {
        if (options.onDispose) onDispose(options.onDispose);

        return {
          clock: () => now,
          analytics: options.limits,
          activity: { operations: options.activity ?? 'disabled' },
          bindings: [
            bind(Events, analytical.table('events')),
            bind(customers, resource),
            bind(owners, {
              connectionId: 'owners',
              resourceId: 'owners',
              connector: {
                identity: 'application',
                async fetch(id) {
                  counters.ownerFetches++;

                  return { state: 'present', record: { id, name: 'allowed' } };
                },
              },
            }),
          ],
        };
      },
    }),
  );

  onTestFinished(() => runtime.close());
  await runtime.host.adopt(Owner, 'owner-one');

  // Make only the authorization dependency stale; the customer remains fresh.
  if (options.nested) now = 61_000;

  const id = await runtime.host.adopt(Customer, 'one');

  Object.assign(counters, {
    fetches: 0,
    identities: 0,
    ownerFetches: 0,
    statements: 0,
  });

  return {
    runtime,
    Customer,
    id,
    counters,
    hooks,
    advanceClock: () => {
      now += 61_000;
    },
    consumer: runtime.as({
      id: 'ana',
      roles: ['reader', 'analyst'],
      claims: { ownerName: 'allowed' },
    }).objects.Customer,
  };
}

const request = { select: ['count'], stale: 'allow' } as const;
const exceeded = {
  code: 'resource-exhausted',
  issues: [{ problem: 'limit-exceeded' }],
};

it.each(['enabled', 'disabled'] as const)(
  'enforces source budgets with capture %s and never falls back to stale data',
  async (activity) => {
    const { consumer, id, counters } = await app({
      limits: { maxSourceCalls: 0 },
      activity,
    });

    expect(await consumer.get(id, request)).toMatchObject({
      status: 'ok',
      data: { count: '7' },
    });
    counters.statements = 0;
    await expect(
      consumer.get(id, { ...request, refresh: true }),
    ).rejects.toMatchObject(exceeded);
    expect(counters.fetches).toBe(0);
    expect(counters.statements).toBe(0);
  },
);

it('gives concurrent operations separate source budgets', async () => {
  const { consumer, id, counters } = await app({
    limits: { maxSourceCalls: 1 },
  });
  const results = await Promise.all([
    consumer.get(id, { ...request, refresh: true }),
    consumer.get(id, { ...request, refresh: true }),
  ]);

  expect(results).toEqual([
    expect.objectContaining({ status: 'ok', data: { count: '7' } }),
    expect.objectContaining({ status: 'ok', data: { count: '7' } }),
  ]);
  expect(counters.fetches).toBe(2);
});

it('shares one budget across all query candidates before SQL', async () => {
  const { runtime, Customer, consumer, counters } = await app({
    limits: { maxSourceCalls: 1 },
  });

  await runtime.host.adopt(Customer, 'two');
  counters.fetches = 0;
  await expect(
    consumer.query({ ...request, refresh: true }),
  ).rejects.toMatchObject(exceeded);
  expect(counters.fetches).toBeLessThanOrEqual(1);
  expect(counters.statements).toBe(0);
});

it('counts provider identity checks even when source data is cached', async () => {
  const { consumer, id, counters } = await app({
    limits: { maxSourceCalls: 0 },
    provider: true,
  });

  await expect(consumer.get(id, request)).rejects.toMatchObject(exceeded);
  expect(counters).toEqual({
    fetches: 0,
    identities: 0,
    ownerFetches: 0,
    statements: 0,
  });
});

it('shares the budget with nested authorization dependencies', async () => {
  const { consumer, id, counters } = await app({
    limits: { maxSourceCalls: 0 },
    nested: true,
  });

  await expect(consumer.get(id, request)).rejects.toMatchObject(exceeded);
  expect(counters).toEqual({
    fetches: 0,
    identities: 0,
    ownerFetches: 0,
    statements: 0,
  });
});

it.each([
  [50, 1000],
  [1000, 50],
])(
  'uses the shorter host (%d ms) or caller (%d ms) deadline for source fetches',
  async (operationTimeoutMs, timeoutMs) => {
    const { consumer, id, hooks, counters } = await app({
      limits: { operationTimeoutMs },
    });
    let aborted = false;

    hooks.fetch = (signal) =>
      new Promise((_, reject) => {
        signal.addEventListener(
          'abort',
          () => {
            aborted = true;
            reject(signal.reason);
          },
          { once: true },
        );
      });
    await expect(
      consumer.get(id, { ...request, refresh: true, timeoutMs }),
    ).rejects.toMatchObject({ code: 'unavailable' });
    expect(aborted).toBe(true);
    expect(counters.statements).toBe(0);
  },
);

it('retires an in-flight source read before closing the runtime', async () => {
  const { runtime, consumer, id, hooks, counters } = await app({ limits: {} });
  let entered!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let aborted = false;

  hooks.fetch = (signal) =>
    new Promise((_, reject) => {
      entered();
      signal.addEventListener(
        'abort',
        () => {
          aborted = true;
          reject(signal.reason);
        },
        { once: true },
      );
    });
  const result = consumer.get(id, { ...request, refresh: true });
  const rejected = expect(result).rejects.toMatchObject({
    code: 'runtime-retired',
  });

  await started;
  await runtime.close();
  await rejected;
  expect(aborted).toBe(true);
  expect(counters.statements).toBe(0);
});

it.each([
  null,
  [],
  { extra: 1 },
  { operationTimeoutMs: null },
  { operationTimeoutMs: 0 },
  { operationTimeoutMs: -1 },
  { operationTimeoutMs: 0.5 },
  { operationTimeoutMs: Infinity },
  { operationTimeoutMs: 2_147_483_648 },
  { maxSourceCalls: null },
  { maxSourceCalls: NaN },
  { maxSourceCalls: -1 },
  { maxSourceCalls: 0.5 },
])('rejects invalid host limits and disposes setup: %j', async (limits) => {
  let disposed = false;

  await expect(
    app({
      limits: limits as AnalyticalLimits,
      onDispose: () => {
        disposed = true;
      },
    }),
  ).rejects.toThrow('Invalid analytical limits');
  expect(disposed).toBe(true);
});

it('counts repeated identity checks in one operation', async () => {
  const { consumer, id, counters } = await app({
    limits: { maxSourceCalls: 1 },
    provider: true,
  });

  await expect(consumer.get(id, request)).rejects.toMatchObject(exceeded);
  expect(counters.identities).toBe(1);
  expect(counters.statements).toBe(0);
});

it('keeps the same source budget during post-SQL revalidation', async () => {
  const { consumer, id, counters, hooks, advanceClock } = await app({
    limits: { maxSourceCalls: 1 },
  });

  hooks.execute = advanceClock;
  await expect(
    consumer.get(id, { ...request, refresh: true }),
  ).rejects.toMatchObject(exceeded);
  expect(counters.fetches).toBe(1);
  expect(counters.statements).toBe(1);
});

it('snapshots host limits at startup', async () => {
  const limits = { maxSourceCalls: 0 };
  const { consumer, id, counters } = await app({ limits });

  limits.maxSourceCalls = 100;
  await expect(
    consumer.get(id, { ...request, refresh: true }),
  ).rejects.toMatchObject(exceeded);
  expect(counters.fetches).toBe(0);
});

it('passes cancellation to provider identity checks', async () => {
  const { consumer, id, hooks, counters } = await app({
    limits: { operationTimeoutMs: 50 },
    provider: true,
  });
  let aborted = false;

  hooks.identify = (signal) =>
    new Promise((_, reject) => {
      signal.addEventListener(
        'abort',
        () => {
          aborted = true;
          reject(signal.reason);
        },
        { once: true },
      );
    });
  await expect(consumer.get(id, request)).rejects.toMatchObject({
    code: 'unavailable',
  });
  expect(aborted).toBe(true);
  expect(counters.statements).toBe(0);
});
