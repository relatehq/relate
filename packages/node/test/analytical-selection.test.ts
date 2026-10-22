import { expect, it } from 'vitest';
import { z } from 'zod';
import { bind, defineApp, defineGraph, defineObject, native } from 'relate';
import { compile } from 'relate/compiler';
import { startApp } from '@relate/node';
import { createMemoryStore } from '@relate/runtime';
import type { AuthorizedDatasetQuery, PreparedPlan } from 'relate/connectors';
import { createAnalyticalGraph } from '../../../tests/support/analytical-graph.js';
import {
  createAnalyticalConnector,
  analyticalGraphSchema,
} from '../../../tests/support/analytical-connector.js';
import { testCreation } from '../../../tests/support/activity.js';

it('adds private analytical dependencies after validating the public selection cap', async () => {
  const base = createAnalyticalGraph();
  const names = Array.from({ length: 100 }, (_, i) => `extra${i}`);
  const Customer = defineObject({
    ...base.Customer,
    properties: {
      ...base.Customer.properties,
      ...Object.fromEntries(
        names.map((name) => [
          name,
          native(z.string().optional(), { id: `customer.${name}` }),
        ]),
      ),
    },
  });
  const graph = defineGraph({ ...base.graph, objects: { Customer } });
  const model = compile(graph);
  const store = createMemoryStore();
  const scope = {
    graphId: graph.id,
    definitionRevision: model.definitionRevision,
  };

  await store.install(scope.graphId, scope.definitionRevision);
  await store.native!.transaction(scope, async (transaction) => {
    await transaction.insert(
      {
        objectDefinitionId: Customer.id,
        objectId: 'one',
        createdAt: Date.now(),
        values: {
          'customer.external': 'acme',
          ...Object.fromEntries(
            names.map((name) => [`customer.${name}`, name]),
          ),
        },
      },
      testCreation(),
    );
  });
  const connector = createAnalyticalConnector(analyticalGraphSchema());
  const plans = new WeakMap<PreparedPlan, AuthorizedDatasetQuery>();
  let statements = 0;

  connector.connection.analytics.plan = (query) => {
    const plan = {} as PreparedPlan;

    plans.set(plan, query);

    return plan;
  };
  connector.connection.analytics.execute = async (plan) => {
    statements++;

    return {
      readAt: new Date().toISOString(),
      rows: plans.get(plan)!.slots.map((_, slot) => ({ slot, values: [7n] })),
    };
  };
  const runtime = await startApp(
    defineApp({
      graph,
      setup: () => ({
        store,
        bindings: [bind(base.Events, connector.table('events'))],
      }),
    }),
  );

  try {
    const consumer = runtime.operations({
      id: 'ana',
      roles: ['reader', 'analyst', 'private'],
      claims: {},
    });
    const get = await consumer.get('customer', 'one', {
      select: names,
      compute: { total: { sql: 'SELECT COUNT(*) FROM self.events' } },
    });

    expect(get).toMatchObject({
      status: 'ok',
      data: { total: '7', extra99: 'extra99' },
    });

    if (get.status === 'ok') expect(get.data).not.toHaveProperty('externalId');

    const page = await consumer.query('customer', {
      select: names,
      orderBy: [{ field: 'count', direction: 'desc' }],
    });

    expect(Object.keys(page.data[0]!.data)).toEqual(names);
    expect(page.data[0]!.meta.computed).toEqual({});
    expect(statements).toBe(2);
    await expect(
      consumer.query('customer', {
        select: [...names, 'label'],
        orderBy: [{ field: 'count', direction: 'desc' }],
      }),
    ).rejects.toMatchObject({ code: 'invalid-request' });
    expect(statements).toBe(2);
    await expect(
      consumer.query('customer', {
        select: names,
        where: { label: 'included' },
        orderBy: [{ field: 'count', direction: 'desc' }],
      }),
    ).rejects.toMatchObject({ code: 'invalid-request' });
    expect(statements).toBe(2);
  } finally {
    await runtime.close();
  }
});
