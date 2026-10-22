import {
  createAnalyticalConnector,
  analyticalGraphSchema,
} from '../../../tests/support/analytical-connector.js';
import { expect, it, vi } from 'vitest';
import { createSqlParser } from '@relate/sql-parser';
import { compile } from 'relate/compiler';
import { CompileError } from 'relate/diagnostics';
import { bind, defineApp, computed } from 'relate';
import { createRuntime, startApp } from '@relate/node';
import { validateDeclaredCalculations } from '@relate/runtime';
import { createAnalyticalGraph } from '../../../tests/support/analytical-graph.js';

it('starts an analytical app with the initialized parser and validates denied declarations', async () => {
  const { graph, Events } = createAnalyticalGraph(
    'SELECT COALESCE(SUM(amount), 0) FROM self.events',
  );
  const connector = createAnalyticalConnector(analyticalGraphSchema());
  const dispose = vi.fn();
  const runtime = await startApp(
    defineApp({
      graph,
      setup({ onDispose }) {
        onDispose(dispose);

        return { bindings: [bind(Events, connector.table('events'))] };
      },
    }),
  );
  const types = validateDeclaredCalculations(
    compile(graph).manifest,
    await createSqlParser(),
  );

  expect(types).toEqual({
    'customer.count': { type: 'int64', nullable: false },
  });
  expect(Object.isFrozen(types)).toBe(true);
  expect(Object.isFrozen(types['customer.count'])).toBe(true);
  await runtime.close();
  await runtime.close();
  expect(dispose).toHaveBeenCalledTimes(1);
});

it.each([
  'SELECT COUNT(*) FROM self.absent',
  'SELECT SUM(secret) FROM self.events',
  'SELECT COUNT(*) FROM self.events WHERE amount = $value',
  'SELECT COUNT(*) FROM self.events WHERE amount = self.count',
  'SELECT COUNT(*) FROM self.events JOIN secret ON TRUE',
])(
  'rejects invalid unused SQL and cleans up setup resources: %s',
  async (sql) => {
    const { graph } = createAnalyticalGraph(sql);
    const dispose = vi.fn();

    try {
      await startApp(
        defineApp({
          graph,
          setup({ onDispose }) {
            onDispose(dispose);

            return { bindings: [] };
          },
        }),
      );
      expect.fail('Expected startup failure');
    } catch (error) {
      expect(error).toBeInstanceOf(CompileError);
      expect((error as CompileError).issues).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            code: 'calculation.invalid-definition',
            definitionId: 'customer.count',
            path: {
              root: 'graph',
              segments: ['objects', 'Customer', 'properties', 'count', 'sql'],
            },
          }),
        ]),
      );
    }

    expect(dispose).toHaveBeenCalledTimes(1);
  },
);

it('reports every invalid declaration with its authored path', async () => {
  const { graph, Customer } = createAnalyticalGraph(
    'SELECT COUNT(*) FROM self.absent',
  );
  const input = {
    ...graph,
    objects: {
      Customer: {
        ...Customer,
        properties: {
          ...Customer.properties,
          second: computed({
            id: 'customer.second',
            sql: 'SELECT SUM(secret) FROM self.events',
          }),
        },
      },
    },
  };

  try {
    await startApp(defineApp({ graph: input }));
    expect.fail('Expected startup failure');
  } catch (error) {
    expect(error).toBeInstanceOf(CompileError);
    expect(
      (error as CompileError).issues.map((issue) => issue.definitionId),
    ).toEqual(['customer.count', 'customer.second']);
  }
});

it('directs synchronous dataset construction to startApp before resource inspection', async () => {
  const { graph, Events } = createAnalyticalGraph();
  const connector = createAnalyticalConnector(analyticalGraphSchema());

  expect(() =>
    createRuntime({
      graph,
      bindings: [bind(Events, connector.table('events'))],
    }),
  ).toThrow('Use startApp');
  expect(connector.described).toEqual([]);
});
