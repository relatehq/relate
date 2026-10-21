import { expect, it, vi } from 'vitest';
import { createSqlParser } from '@relate/sql-parser';
import { compile } from 'relate/compiler';
import { CompileError } from 'relate/diagnostics';
import { defineApp, computed } from 'relate';
import { createRuntime, startApp } from '@relate/node';
import { validateDeclaredCalculations } from '@relate/runtime';
import { createAnalyticalGraph } from '../../../tests/support/analytical-graph.js';

it('starts an analytical app with the initialized parser and validates denied declarations', async () => {
  const { graph } = createAnalyticalGraph(
    'SELECT COALESCE(SUM(amount), 0) FROM self.events',
  );
  const dispose = vi.fn();
  const runtime = await startApp(
    defineApp({
      graph,
      setup({ onDispose }) {
        onDispose(dispose);

        return { bindings: [] };
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
  const parser = await createSqlParser();

  try {
    createRuntime({ graph: input, bindings: [], sqlParser: parser });
    expect.fail('Expected startup failure');
  } catch (error) {
    expect(error).toBeInstanceOf(CompileError);
    expect(
      (error as CompileError).issues.map((issue) => issue.definitionId),
    ).toEqual(['customer.count', 'customer.second']);
  }
});

it('requires initialized parser injection for synchronous analytical runtime construction', async () => {
  const { graph } = createAnalyticalGraph();

  expect(() => createRuntime({ graph, bindings: [] })).toThrow(
    'initialized SQL parser',
  );
  const parser = await createSqlParser();
  const parse = vi.fn(parser.parse);
  const runtime = createRuntime({
    graph,
    bindings: [],
    sqlParser: { ...parser, parse },
  });

  expect(parse).toHaveBeenCalledWith('SELECT COUNT(*) FROM self.events');
  await runtime.close();
});
