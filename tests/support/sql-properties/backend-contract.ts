import fc from 'fast-check';
import { expect, it, onTestFinished } from 'vitest';
import { bind, defineApp } from 'relate';
import { compile } from 'relate/compiler';
import { startApp } from '@relate/node';
import { createMemoryStore } from '@relate/runtime';
import type { AnalyticalResource } from 'relate/connectors';
import { testCreation } from '../activity.js';
import { propertyQuery, propertyRow } from './arbitraries.js';
import { createSqlPropertyGraph, propertyCustomers } from './model.js';
import type { PropertyRow } from './model.js';
import { renderQuery } from './query.js';
import { approximate, referenceValue } from './reference.js';

export interface PropertyBackend {
  readonly resource: AnalyticalResource;
  /** Replace every dataset row before the next generated case. */
  replace(rows: readonly PropertyRow[]): Promise<void>;
  close(): Promise<void>;
}

/** Replay a failure with RELATE_PROPERTY_SEED and RELATE_PROPERTY_PATH from its report. */
function parameters(): fc.Parameters<unknown> {
  const runs = Number(process.env.RELATE_PROPERTY_RUNS ?? 500);
  const seed = process.env.RELATE_PROPERTY_SEED;
  const path = process.env.RELATE_PROPERTY_PATH;

  return {
    numRuns: runs,
    ...(seed ? { seed: Number(seed) } : {}),
    ...(path ? { path } : {}),
  };
}

/**
 * Differential contract: generated Relate SQL and rows run through the public
 * Node host on a real backend, and must equal an independent reference
 * evaluation. Every backend that passes agrees with every other one.
 */
export function sqlPropertyBackendContract(
  name: string,
  open: () => Promise<PropertyBackend>,
) {
  it(`${name} matches the reference evaluator for generated queries`, async () => {
    const { graph, Events } = createSqlPropertyGraph();
    const model = compile(graph);
    const backend = await open();

    onTestFinished(() => backend.close());
    const store = createMemoryStore();
    const scope = {
      graphId: graph.id,
      definitionRevision: model.definitionRevision,
    };

    await store.install(scope.graphId, scope.definitionRevision);
    await store.native!.transaction(scope, async (transaction) => {
      for (const customer of propertyCustomers)
        await transaction.insert(
          {
            objectDefinitionId: 'customer',
            objectId: customer.id,
            createdAt: 1,
            values: {
              'customer.external': customer.external,
              'customer.since': customer.since,
            },
          },
          testCreation(),
        );
    });
    const runtime = await startApp(
      defineApp({
        graph,
        setup: () => ({
          store,
          bindings: [bind(Events, backend.resource)],
        }),
      }),
    );

    onTestFinished(() => runtime.close());
    const actor = runtime.operations({
      id: 'reader',
      roles: ['reader'],
      claims: {},
    });

    await fc.assert(
      fc.asyncProperty(
        fc.array(propertyRow, { maxLength: 10 }),
        fc.array(propertyQuery, { minLength: 1, maxLength: 4 }),
        async (rows, queries) => {
          await backend.replace(rows);
          const rendered = queries.map(renderQuery);
          const page = await actor.query('customer', {
            select: [],
            compute: Object.fromEntries(
              rendered.map(({ sql, parameters }, index) => [
                `q${index}`,
                {
                  sql,
                  ...(Object.keys(parameters).length ? { parameters } : {}),
                },
              ]),
            ),
          });

          expect(page.data.map((row) => row.id).sort()).toEqual(
            propertyCustomers.map((customer) => customer.id),
          );

          for (const row of page.data) {
            const customer = propertyCustomers.find(
              (entry) => entry.id === row.id,
            )!;

            queries.forEach((query, index) => {
              const actual = (row.data as Record<string, unknown>)[`q${index}`];
              const expected = referenceValue(query, rows, customer);
              const context = `${rendered[index]!.sql} ${JSON.stringify(rendered[index]!.parameters)} for ${customer.id}`;

              if (
                approximate(query) &&
                typeof actual === 'number' &&
                typeof expected === 'number'
              )
                expect(
                  Math.abs(actual - expected),
                  context,
                ).toBeLessThanOrEqual(1e-12 * Math.max(1, Math.abs(expected)));
              else expect(actual, context).toEqual(expected);
            });
          }
        },
      ),
      parameters(),
    );
  }, 120_000);
}
