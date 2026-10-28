import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  bind,
  defineAccess,
  defineApp,
  defineDataset,
  defineGraph,
  defineObject,
  native,
  nativeMembership,
  objectId,
} from 'relate';
import { compile } from 'relate/compiler';
import { startApp } from '@relate/node';
import { createMemoryStore } from '@relate/runtime';
import type { AnalyticalResource } from 'relate/connectors';
import { testCreation } from './activity.js';

/** `customerId`, `a` int64, `b` int64, `small` int32, `x` float64, `y` float64. */
export type RowArithmeticRow = readonly [
  string,
  bigint | null,
  bigint | null,
  number | null,
  number | null,
  number | null,
];

export interface RowArithmeticBackend {
  readonly resource: AnalyticalResource;
  close(): Promise<void>;
}

const M = 9223372036854775807n;
const MAX = Number.MAX_VALUE;
const MIN_SUBNORMAL = Number.MIN_VALUE;

type Cell = { value: unknown } | { failed: string };

function nextUp(value: number): number {
  const view = new DataView(new ArrayBuffer(8));

  view.setFloat64(0, value);
  view.setBigUint64(0, view.getBigUint64(0) + (value >= 0 ? 1n : -1n));

  return view.getFloat64(0);
}

function nextDown(value: number): number {
  return -nextUp(-value);
}

function createGraph() {
  const access = defineAccess({
    roles: ['reader'],
    fieldGroups: ['ordinary'],
    claims: {},
  });
  const column = <T extends z.ZodType>(id: string, schema: T) => ({
    id,
    schema,
    access: access.groups.ordinary,
  });
  const Amounts = defineDataset({
    id: 'amounts',
    columns: {
      customerId: column('amounts.customer', z.string()),
      a: column('amounts.a', z.int64().nullable()),
      b: column('amounts.b', z.int64().nullable()),
      small: column('amounts.small', z.int32().nullable()),
      x: column('amounts.x', z.number().nullable()),
      y: column('amounts.y', z.number().nullable()),
    },
  });
  const Customer = defineObject({
    id: 'customer',
    membership: nativeMembership(),
    properties: {
      id: objectId({ id: 'customer.id' }),
      externalId: native(z.string(), { id: 'customer.external' }),
      rate: native(z.number(), { id: 'customer.rate' }),
    },
    datasets: {
      amounts: {
        id: 'customer.amounts',
        dataset: Amounts,
        on: [{ column: 'customerId', property: 'externalId' }],
      },
    },
  });
  const graph = defineGraph({
    id: 'row-arithmetic',
    access,
    objects: { Customer },
    datasets: { Amounts },
    policies: {
      Customer: {
        read: { gate: access.role('reader') },
        datasets: { amounts: { gate: access.role('reader') } },
      },
      Amounts: {},
    },
  });

  return { graph, Amounts };
}

/** Checked row arithmetic and accumulation through the public host on one backend. */
export function rowArithmeticContract(
  name: string,
  open: (rows: readonly RowArithmeticRow[]) => Promise<RowArithmeticBackend>,
) {
  describe(name, () => {
    const cleanup: (() => Promise<void>)[] = [];

    afterEach(async () => {
      for (const close of cleanup.splice(0).reverse()) await close();
    });

    /** One statement over every customer; each customer id is its dataset key. */
    async function compute(
      rows: readonly RowArithmeticRow[],
      fields: Readonly<
        Record<
          string,
          string | { sql: string; parameters: Record<string, number> }
        >
      >,
      rates: Readonly<Record<string, number>> = {},
    ): Promise<Record<string, Record<string, Cell>>> {
      const { graph, Amounts } = createGraph();
      const model = compile(graph);
      const backend = await open(rows);

      cleanup.push(() => backend.close());
      const base = backend.resource.connection;
      let statements = 0;
      const resource = {
        ...backend.resource,
        connection: {
          ...base,
          analytics: {
            ...base.analytics,
            execute(...args: Parameters<typeof base.analytics.execute>) {
              statements++;

              return base.analytics.execute(...args);
            },
          },
        },
      };
      const store = createMemoryStore();
      const scope = {
        graphId: graph.id,
        definitionRevision: model.definitionRevision,
      };
      const customers = [
        ...new Set([...rows.map((row) => row[0]), ...Object.keys(rates)]),
      ];

      await store.install(scope.graphId, scope.definitionRevision);
      await store.native!.transaction(scope, async (transaction) => {
        for (const id of customers)
          await transaction.insert(
            {
              objectDefinitionId: 'customer',
              objectId: id,
              createdAt: 1,
              values: {
                'customer.external': id,
                'customer.rate': rates[id] ?? 1,
              },
            },
            testCreation(),
          );
      });
      const runtime = await startApp(
        defineApp({
          graph,
          setup: () => ({ store, bindings: [bind(Amounts, resource)] }),
        }),
      );

      cleanup.push(() => runtime.close());
      const page = await runtime
        .operations({ id: 'reader', roles: ['reader'], claims: {} })
        .query('customer', {
          select: [],
          evidence: 'full',
          limit: 100,
          compute: Object.fromEntries(
            Object.entries(fields).map(([field, value]) => [
              field,
              typeof value === 'string' ? { sql: value } : value,
            ]),
          ),
        });

      // Every field shares one association, so one statement serves them all.
      expect(statements).toBe(1);

      return Object.fromEntries(
        page.data.map((row) => [
          row.id,
          Object.fromEntries(
            Object.keys(fields).map((field) => {
              const meta = row.meta.fields?.[field] as
                { status: string; reason?: string } | undefined;

              return [
                field,
                meta?.status === 'available'
                  ? { value: (row.data as Record<string, unknown>)[field] }
                  : { failed: meta?.reason ?? 'missing' },
              ];
            }),
          ),
        ]),
      );
    }

    const failed = { failed: 'execution-failed' };
    const sql = (aggregate: string) => `SELECT ${aggregate} FROM self.amounts`;

    it('evaluates nested arithmetic with precedence, promotion and null propagation', async () => {
      const rows: RowArithmeticRow[] = [
        ['p', 3n, 2n, 4, 0.5, 2.5],
        ['p', 5n, null, 1, null, 1],
      ];
      // The request expression limit is eight, so the cases use two requests.
      const shapes = await compute(rows, {
        product: sql('SUM(a * b)'),
        precedence: sql('SUM(a + b * 2)'),
        parentheses: sql('SUM((a + b) * 2)'),
        division: sql('MAX(a / b)'),
        mixed: sql('SUM(small * x)'),
        scaled: sql('SUM(a * 1.0)'),
        counted: sql('COUNT(a + b)'),
      });
      const operands = await compute(
        rows,
        {
          averaged: sql('AVG(a - small)'),
          minimum: sql('MIN(b - a)'),
          self: sql('SUM(y * self.rate)'),
          scale: { sql: sql('SUM(a * $scale)'), parameters: { scale: 3 } },
          fraction: {
            sql: sql('SUM(x * $scale)'),
            parameters: { scale: 0.5 },
          },
          formula: sql('SUM(a * b) / SUM(small)'),
        },
        { p: 2 },
      );

      expect(shapes.p).toEqual({
        product: { value: '6' },
        precedence: { value: '7' },
        parentheses: { value: '10' },
        division: { value: 1.5 },
        mixed: { value: 2 },
        scaled: { value: 8 },
        counted: { value: '1' },
      });
      expect(operands.p).toEqual({
        averaged: { value: 1.5 },
        minimum: { value: '-1' },
        self: { value: 7 },
        scale: { value: '24' },
        fraction: { value: 0.25 },
        formula: { value: 1.2 },
      });
    });

    it('fails only the affected cell on integer overflow, even after cancellation', async () => {
      const result = await compute(
        [
          ['over', M, 1n, 1, 1, 1],
          ['over', 1n, 1n, 1, 1, 1],
          ['fine', 1n, 2n, 1, 1, 1],
        ],
        {
          plus: sql('SUM(a + 0)'),
          bump: sql('SUM(a + b)'),
          cancelled: sql('SUM((a + b) - b)'),
          promoted: sql('SUM((a + b) * 1.0)'),
          product: sql('SUM(a * a)'),
          count: sql('COUNT(*)'),
        },
      );

      expect(result.over).toEqual({
        plus: failed,
        bump: failed,
        cancelled: failed,
        promoted: failed,
        product: failed,
        count: { value: '2' },
      });
      expect(result.fine).toEqual({
        plus: { value: '1' },
        bump: { value: '3' },
        cancelled: { value: '1' },
        promoted: { value: 3 },
        product: { value: '1' },
        count: { value: '1' },
      });
    });

    it('checks multiplication against both int64 limits', async () => {
      const result = await compute(
        [
          ['high', 4294967296n, 2147483648n, null, null, null],
          ['low', -4294967296n, 2147483648n, null, null, null],
          ['wide', 4294967296n, 4294967296n, null, null, null],
        ],
        { product: sql('MAX(a * b)') },
      );

      expect(result).toEqual({
        high: { product: failed },
        low: { product: { value: '-9223372036854775808' } },
        wide: { product: failed },
      });
    });

    it('fails float overflow and zero denominators, and keeps underflow and subnormals', async () => {
      const result = await compute(
        [
          ['overflow', null, null, null, 1e308, 10],
          ['zero', 1n, 0n, null, 1, 0],
          ['negativeZero', null, null, null, 1, -0],
          ['underflow', null, null, null, 1e-300, 1e-300],
          ['subnormal', null, null, null, MIN_SUBNORMAL, 1],
        ],
        {
          product: sql('MAX(x * y)'),
          quotient: sql('MAX(x / y)'),
          integerQuotient: sql('MAX(a / b)'),
          inverse: sql('MAX(1.0 / (x * y))'),
        },
      );

      expect(result.overflow).toMatchObject({
        product: failed,
        quotient: { value: 1e307 },
      });
      expect(result.zero).toMatchObject({
        product: { value: 0 },
        quotient: failed,
        integerQuotient: failed,
        inverse: failed,
      });
      expect(result.negativeZero).toMatchObject({ quotient: failed });
      expect(result.underflow).toMatchObject({
        product: { value: 0 },
        quotient: { value: 1 },
        inverse: failed,
      });
      expect(result.subnormal).toMatchObject({
        product: { value: MIN_SUBNORMAL },
        quotient: { value: MIN_SUBNORMAL },
      });
    });

    it('classifies adjacent float64 values around overflow, round-to-zero and subnormal boundaries', async () => {
      const pairs: (readonly [number, number])[] = [
        [MAX, 1],
        [MAX, nextUp(1)],
        [MAX, nextDown(1)],
        [nextDown(2 ** 512), 2 ** 512],
        [2 ** 512, 2 ** 512],
        [-MAX, nextUp(1)],
        [2 ** -537, 2 ** -538],
        [2 ** -537, nextUp(2 ** -538)],
        [2 ** -537, nextDown(2 ** -538)],
        [MIN_SUBNORMAL, 0.5],
        [MIN_SUBNORMAL, nextUp(0.5)],
        [MIN_SUBNORMAL, 1.5],
        [-MIN_SUBNORMAL, 0.75],
        [2 ** -1022, nextDown(1)],
        [MAX, 2 ** 970],
        [MAX, nextDown(2 ** 970)],
        [-MAX, -(2 ** 970)],
        [2 ** 1023, 2 ** 1023],
        [nextDown(2 ** 1023), 2 ** 1023],
        [MAX, -MAX],
        [MAX, 0.5],
        [MAX, nextUp(0.5)],
        [MIN_SUBNORMAL, 2],
        [MIN_SUBNORMAL, nextDown(2)],
        [2 ** -1000, 2 ** 75],
        [1, 3],
        [0, 5],
      ];
      const rows = pairs.map(([x, y], i): RowArithmeticRow => [
        `c${i}`,
        null,
        null,
        null,
        x,
        y,
      ]);
      const result = await compute(rows, {
        product: sql('MAX(x * y)'),
        sum: sql('MAX(x + y)'),
        difference: sql('MAX(x - y)'),
        quotient: sql('MAX(x / y)'),
        total: sql('SUM(x * y)'),
      });
      const expected = (value: number): Cell =>
        Number.isFinite(value) ? { value: value === 0 ? 0 : value } : failed;

      for (const [i, [x, y]] of pairs.entries())
        expect([x, y, result[`c${i}`]]).toEqual([
          x,
          y,
          {
            product: expected(x * y),
            sum: expected(x + y),
            difference: expected(x - y),
            quotient: y === 0 ? failed : expected(x / y),
            total: expected(x * y),
          },
        ]);
    });

    it('never raises for constant or parameter operands outside the range', async () => {
      const result = await compute([['k', 1n, null, null, 1, 1]], {
        literal: sql('SUM(x * 0.0 + 1e308 * 10.0)'),
        underflow: sql('SUM(x * 0.0 + 1e-300 * 1e-300)'),
        zero: sql('SUM(x / 0.0)'),
        integer: sql('SUM(a * 0 + 9223372036854775807 + 1)'),
        parameter: {
          sql: sql('SUM(x * $big * 10.0)'),
          parameters: { big: 1e308 },
        },
        tiny: {
          sql: sql('SUM(x * 0.0 + $tiny * 1.0 * $tiny)'),
          parameters: { tiny: MIN_SUBNORMAL },
        },
      });

      expect(result.k).toEqual({
        literal: failed,
        underflow: { value: 0 },
        zero: failed,
        integer: failed,
        parameter: failed,
        tiny: { value: 0 },
      });
    });

    it('accumulates exactly regardless of row order and partial overflow', async () => {
      const result = await compute(
        [
          ['cancel', M, null, null, 1e308, null],
          ['cancel', 1n, null, null, 1e308, null],
          ['cancel', -1n, null, null, -1e308, null],
          ['reverse', -1n, null, null, -1e308, null],
          ['reverse', 1n, null, null, 1e308, null],
          ['reverse', M, null, null, 1e308, null],
          ['over', M, null, null, 1e308, null],
          ['over', 1n, null, null, 1e308, null],
          ['mean', M, null, null, 1e308, null],
          ['mean', M, null, null, 1e308, null],
        ],
        {
          sum: sql('SUM(a)'),
          sumRow: sql('SUM(a + 0)'),
          average: sql('AVG(a)'),
          averageRow: sql('AVG(a + 0)'),
          float: sql('SUM(x)'),
          floatRow: sql('SUM(x * 1.0)'),
          floatAverage: sql('AVG(x)'),
          floatAverageRow: sql('AVG(x * 1.0)'),
        },
      );

      for (const id of ['cancel', 'reverse'])
        expect(result[id]).toMatchObject({
          sum: { value: String(M) },
          sumRow: { value: String(M) },
          float: { value: expect.closeTo(1e308, -300) },
          floatRow: { value: expect.closeTo(1e308, -300) },
        });

      expect(result.over).toMatchObject({
        sum: failed,
        sumRow: failed,
        float: failed,
        floatRow: failed,
        average: { value: expect.closeTo(Number(M) / 2, -3) },
      });
      expect(result.mean).toMatchObject({
        average: { value: Number(M) },
        averageRow: { value: Number(M) },
        floatAverage: { value: expect.closeTo(1e308, -300) },
        floatAverageRow: { value: expect.closeTo(1e308, -300) },
        sum: failed,
        float: failed,
      });
    });

    it('divides exact integer totals before rounding averages to float64', async () => {
      const result = await compute(
        [
          ['positive', 9007199254740993n, null, null, null, null],
          ['positive', 0n, null, null, null, null],
          ['positive', 0n, null, null, null, null],
          ['negative', -9007199254740993n, null, null, null, null],
          ['negative', 0n, null, null, null, null],
          ['negative', 0n, null, null, null, null],
          ['cancel', M, null, null, null, null],
          ['cancel', 1n, null, null, null, null],
          ['cancel', -M, null, null, null, null],
          ['minimum', -M - 1n, null, null, null, null],
          ['minimum', -M - 1n, null, null, null, null],
          ['maximum', M, null, null, null, null],
          ['maximum', M, null, null, null, null],
          ['nulls', null, null, null, null, null],
        ],
        {
          plain: sql('AVG(a)'),
          row: sql('AVG(a + 0)'),
        },
        { empty: 1 },
      );

      for (const [id, value] of Object.entries({
        positive: 3002399751580331,
        negative: -3002399751580331,
        cancel: 1 / 3,
        minimum: Number(-M - 1n),
        maximum: Number(M),
        nulls: null,
        empty: null,
      }))
        expect(result[id]).toEqual({ plain: { value }, row: { value } });
    });

    it('preserves child failures through nulls and both branches of a row node', async () => {
      const result = await compute([['bad', M, null, null, 1e308, null]], {
        integerNull: sql('SUM((a + 1) + b)'),
        floatNull: sql('SUM((x * 10.0) + y)'),
        promotedNull: sql('SUM((a + 1) * y)'),
        both: sql('SUM((a + 1) * (a + 1))'),
        healthy: sql('COUNT(*)'),
      });

      expect(result.bad).toEqual({
        integerNull: failed,
        floatNull: failed,
        promotedNull: failed,
        both: failed,
        healthy: { value: '1' },
      });
    });

    it('retains non-finite input failures beside null operands and finite siblings', async () => {
      const result = await compute(
        [
          ['bad', 1n, null, null, Infinity, null],
          ['bad', 1n, null, null, -Infinity, null],
          ['fine', 1n, null, null, 2, 3],
        ],
        {
          row: sql('SUM(x + y)'),
          plain: sql('SUM(x)'),
          average: sql('AVG(x)'),
          minimum: sql('MIN(x)'),
          maximum: sql('MAX(x)'),
          healthy: sql('COUNT(*)'),
        },
      );

      expect(result.bad).toEqual({
        row: failed,
        plain: failed,
        average: failed,
        minimum: failed,
        maximum: failed,
        healthy: { value: '2' },
      });
      expect(result.fine).toEqual({
        row: { value: 5 },
        plain: { value: 2 },
        average: { value: 2 },
        minimum: { value: 2 },
        maximum: { value: 2 },
        healthy: { value: '1' },
      });
    });

    it('keeps a bad row visible in every aggregate, formula and fallback', async () => {
      const result = await compute(
        [
          ['bad', M, 1n, null, null, null],
          ['bad', 1n, 1n, null, null, null],
        ],
        {
          maximum: sql('MAX(a + b)'),
          minimum: sql('MIN(a + b)'),
          count: sql('COUNT(a + b)'),
          average: sql('AVG(a + b)'),
          fallback: sql('COALESCE(SUM(a + b), 0)'),
          formula: sql('SUM(b) / SUM(a + b)'),
          outer: sql('COALESCE(MAX(a + b), 0) + COUNT(*)'),
          healthy: sql('SUM(b)'),
        },
      );

      expect(result.bad).toEqual({
        maximum: failed,
        minimum: failed,
        count: failed,
        average: failed,
        fallback: failed,
        formula: failed,
        outer: failed,
        healthy: { value: '2' },
      });
    });

    it('ignores failures in rows that a filter or WHERE clause excludes', async () => {
      const result = await compute(
        [
          ['mixed', M, 1n, null, 1e308, 10],
          ['mixed', 1n, 1n, null, 1, 10],
        ],
        {
          filtered: sql('SUM(a + b) FILTER (WHERE a < 100)'),
          where: `${sql('SUM(x * y)')} WHERE x < 100`,
          unfiltered: sql('SUM(a + b)'),
        },
      );

      expect(result.mixed).toEqual({
        filtered: { value: '2' },
        where: { value: 10 },
        unfiltered: failed,
      });
    });

    it('keeps empty and all-null aggregates unchanged', async () => {
      const result = await compute(
        [['nulls', null, null, null, null, null]],
        {
          sum: sql('SUM(a + b)'),
          float: sql('SUM(x * y)'),
          average: sql('AVG(x)'),
          count: sql('COUNT(a * b)'),
          fallback: sql('COALESCE(SUM(a * 2), 7)'),
        },
        { empty: 1 },
      );

      for (const id of ['nulls', 'empty'])
        expect(result[id]).toEqual({
          sum: { value: null },
          float: { value: null },
          average: { value: null },
          count: { value: '0' },
          fallback: { value: '7' },
        });
    });
  });
}
