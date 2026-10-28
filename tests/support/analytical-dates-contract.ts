import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
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
import type { ObjectQueryRequest } from '@relate/protocol';
import type { AnalyticalResource } from 'relate/connectors';
import { testCreation } from './activity.js';

/**
 * `customerId` and `day`. Each backend stores `day` in its physical date type
 * and adds `label` text and `loadedAt` millisecond-timestamp columns with any
 * value, so type mismatches can be prepared against real columns.
 */
export type DateRow = readonly [string, string | null];

export interface AnalyticalDatesBackend {
  readonly resource: AnalyticalResource;
  close(): Promise<void>;
}

export interface AnalyticalDatesOptions {
  /** Stored values that must withdraw a date result as `invalid-result`. */
  readonly invalidResults?: readonly string[];
  /**
   * Stored values the backend cannot prove are dates before reading them, such
   * as SQLite TEXT. Any participating one fails the statement.
   */
  readonly malformed?: readonly string[];
}

type Cell = { value: unknown } | { failed: string };

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
  const Days = defineDataset({
    id: 'days',
    columns: {
      customerId: column('days.customer', z.string()),
      day: column('days.day', z.iso.date().nullable()),
      label: column('days.label', z.string()),
      loadedAt: column(
        'days.loadedAt',
        z.iso.datetime({ offset: true, precision: 3 }),
      ),
    },
  });
  const Customer = defineObject({
    id: 'customer',
    membership: nativeMembership(),
    properties: {
      id: objectId({ id: 'customer.id' }),
      externalId: native(z.string(), { id: 'customer.external' }),
    },
    datasets: {
      days: {
        id: 'customer.days',
        dataset: Days,
        on: [{ column: 'customerId', property: 'externalId' }],
      },
    },
  });
  const graph = defineGraph({
    id: 'analytical-dates',
    access,
    objects: { Customer },
    datasets: { Days },
    policies: {
      Customer: {
        read: { gate: access.role('reader') },
        datasets: { days: { gate: access.role('reader') } },
      },
      Days: {},
    },
  });

  return { graph, Days };
}

/**
 * Calendar dates through the public host on one backend, under each process
 * timezone. `open` receives the timezone so a backend can also set its session
 * timezone; date results must not move by a day under either.
 */
export function analyticalDatesContract(
  name: string,
  open: (
    rows: readonly DateRow[],
    timezone: string,
  ) => Promise<AnalyticalDatesBackend>,
  options: AnalyticalDatesOptions = {},
) {
  describe.each(['Pacific/Kiritimati', 'America/Adak', 'Pacific/Apia'])(
    `${name} (TZ=%s)`,
    (timezone) => {
      const cleanup: (() => Promise<void>)[] = [];
      const original = process.env.TZ;

      beforeAll(() => {
        process.env.TZ = timezone;
      });

      afterAll(() => {
        if (original === undefined) delete process.env.TZ;
        else process.env.TZ = original;
      });

      afterEach(async () => {
        for (const close of cleanup.splice(0).reverse()) await close();
      });

      async function app(rows: readonly DateRow[]) {
        const { graph, Days } = createGraph();
        const model = compile(graph);
        const backend = await open(rows, timezone);

        cleanup.push(() => backend.close());
        const store = createMemoryStore();
        const scope = {
          graphId: graph.id,
          definitionRevision: model.definitionRevision,
        };

        await store.install(scope.graphId, scope.definitionRevision);
        await store.native!.transaction(scope, async (transaction) => {
          for (const id of new Set(rows.map((row) => row[0])))
            await transaction.insert(
              {
                objectDefinitionId: 'customer',
                objectId: id,
                createdAt: 1,
                values: { 'customer.external': id },
              },
              testCreation(),
            );
        });
        const runtime = await startApp(
          defineApp({
            graph,
            setup: () => ({
              store,
              cursorKey: new Uint8Array(32).fill(7),
              bindings: [bind(Days, backend.resource)],
            }),
          }),
        );

        cleanup.push(() => runtime.close());

        return (request: ObjectQueryRequest) =>
          runtime
            .operations({ id: 'reader', roles: ['reader'], claims: {} })
            .query('customer', request);
      }

      async function compute(
        rows: readonly DateRow[],
        fields: Readonly<
          Record<
            string,
            string | { sql: string; parameters: Record<string, string> }
          >
        >,
      ): Promise<Record<string, Record<string, Cell>>> {
        const query = await app(rows);
        const page = await query({
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

      const sql = (aggregate: string, where = '') =>
        `SELECT ${aggregate} FROM self.days d${where ? ` WHERE ${where}` : ''}`;

      it('round-trips leap days, year zero, the last day and null without shifting', async () => {
        const days = [
          '2024-02-29',
          '0000-01-01',
          '0000-02-29',
          '9999-12-31',
          '2011-12-30',
          '2026-10-01',
        ];
        const result = await compute(
          [...days.map((day) => [day, day] as const), ['none', null]],
          {
            first: sql('MIN(d.day)'),
            last: sql('MAX(d.day)'),
            counted: sql('COUNT(d.day)'),
            // Year-zero parameters bind without shifting: 0000-02-29 is 1 BC on Postgres.
            fromLeapZero: {
              sql: sql('COUNT(*)', 'd.day >= $from'),
              parameters: { from: '0000-02-29' },
            },
            beforeYearOne: {
              sql: sql('COUNT(*)', 'd.day < $to'),
              parameters: { to: '0001-01-01' },
            },
          },
        );

        for (const day of days)
          expect(result[day]).toEqual({
            first: { value: day },
            last: { value: day },
            counted: { value: '1' },
            fromLeapZero: { value: day === '0000-01-01' ? '0' : '1' },
            beforeYearOne: { value: day.startsWith('0000-') ? '1' : '0' },
          });

        expect(result.none).toEqual({
          first: { value: null },
          last: { value: null },
          counted: { value: '0' },
          fromLeapZero: { value: '0' },
          beforeYearOne: { value: '0' },
        });
      });

      it('orders across years and compares with literals and typed parameters', async () => {
        const rows: DateRow[] = [
          ['m', '2026-09-30'],
          ['m', '2026-10-01'],
          ['m', '2026-10-15'],
          ['m', '2026-11-01'],
          ['m', '0999-12-31'],
          ['m', null],
        ];
        const result = await compute(rows, {
          first: sql('MIN(d.day)'),
          last: sql('MAX(d.day)'),
          october: {
            sql: sql('COUNT(*)', 'd.day >= $from AND d.day < $to'),
            parameters: { from: '2026-10-01', to: '2026-11-01' },
          },
          firstInRange: {
            sql: sql('MIN(d.day)', 'd.day > $from'),
            parameters: { from: '2026-10-01' },
          },
          exact: sql('COUNT(*)', `d.day = '2026-10-15'`),
          missing: sql('COUNT(*)', 'd.day IS NULL'),
          lastBefore: sql('MAX(d.day)', `d.day <= '2026-10-14'`),
        });

        expect(result.m).toEqual({
          first: { value: '0999-12-31' },
          last: { value: '2026-11-01' },
          october: { value: '2' },
          firstInRange: { value: '2026-10-15' },
          exact: { value: '1' },
          missing: { value: '1' },
          lastBefore: { value: '2026-10-01' },
        });
      });

      it('filters, orders and continues pages by a computed date', async () => {
        const query = await app([
          ['a', '2026-10-03'],
          ['b', '2024-02-29'],
          ['c', '2026-10-01'],
          ['d', null],
          ['e', '2026-10-01'],
        ]);
        const ordered = {
          select: [],
          compute: { first: { sql: sql('MIN(d.day)') } },
          orderBy: [{ field: 'first', direction: 'asc' }],
          limit: 2,
        } as const;
        const first = await query(ordered);

        expect(first.data.map((row) => [row.id, row.data.first])).toEqual([
          ['b', '2024-02-29'],
          ['c', '2026-10-01'],
        ]);
        expect(first.meta.exhausted).toBe(false);

        if (first.meta.exhausted) return;

        const next = await query({
          ...ordered,
          cursor: first.meta.continuationCursor,
        });

        expect(next.data.map((row) => [row.id, row.data.first])).toEqual([
          ['e', '2026-10-01'],
          ['a', '2026-10-03'],
        ]);

        const filtered = await query({
          ...ordered,
          limit: 100,
          where: { first: { gte: '2026-10-01', lt: '2026-10-03' } },
        });

        expect(filtered.data.map((row) => row.id)).toEqual(['c', 'e']);

        const matched = await query({
          ...ordered,
          limit: 100,
          where: { first: { in: ['2024-02-29', '2026-10-03'] } },
        });

        expect(matched.data.map((row) => row.id)).toEqual(['b', 'a']);
      });

      it.each([
        '2026-02-29',
        '2026-1-01',
        '2026-10-01 ',
        '2026-10-01T00:00:00Z',
        'infinity',
        '10000-01-01',
      ])('rejects the non-canonical parameter %j', async (from) => {
        const query = await app([['a', '2026-10-01']]);

        await expect(
          query({
            select: [],
            compute: {
              n: {
                sql: sql('COUNT(*)', 'd.day >= $from'),
                parameters: { from },
              },
            },
          }),
        ).rejects.toMatchObject({
          issues: [
            expect.objectContaining({
              message: 'Parameter does not match its inferred type.',
            }),
          ],
        });
      });

      it.each([
        ['SUM(d.day)', 'This aggregate requires a numeric operand.'],
        ['AVG(d.day)', 'This aggregate requires a numeric operand.'],
        ['MAX(d.day + 1)', 'Row arithmetic requires numeric operands.'],
        ['COUNT(*) FROM self.days d WHERE d.day = d.label', 'incompatible'],
        ['COUNT(*) FROM self.days d WHERE d.day = d.loadedAt', 'incompatible'],
        ["COUNT(*) FROM self.days d WHERE d.day = '2026-02-29'", 'Literal'],
      ])('rejects %s at preparation', async (expression, message) => {
        const query = await app([['a', '2026-10-01']]);
        const text = expression.includes(' FROM ')
          ? `SELECT ${expression}`
          : sql(expression);

        await expect(
          query({ select: [], compute: { bad: { sql: text } } }),
        ).rejects.toMatchObject({
          issues: [
            expect.objectContaining({
              message: expect.stringContaining(message),
            }),
          ],
        });
      });

      // An invalid result withdraws its alias across the whole scope, as for
      // every other type; other aliases in the same statement stay available.
      it.runIf(options.invalidResults?.length)(
        'withdraws out-of-range and infinite results as invalid-result',
        async () => {
          const values = options.invalidResults!;
          const result = await compute(
            [
              ...values.map((day) => [day, day] as const),
              ['fine', '2026-10-01'],
            ],
            { first: sql('MIN(d.day)'), counted: sql('COUNT(d.day)') },
          );

          for (const value of values)
            expect(result[value]).toEqual({
              first: { failed: 'invalid-result' },
              counted: { value: '1' },
            });

          expect(result.fine).toEqual({
            first: { failed: 'invalid-result' },
            counted: { value: '1' },
          });
        },
      );

      it.runIf(options.malformed?.length).each(options.malformed ?? [])(
        'fails the statement when malformed stored text %j participates',
        async (stored) => {
          const result = await compute(
            [
              ['bad', stored],
              ['fine', '2026-10-01'],
            ],
            {
              first: sql('MIN(d.day)'),
              counted: sql('COUNT(d.day)'),
              filtered: sql('COUNT(*)', `d.day >= '2026-01-01'`),
            },
          );
          const failed = { failed: 'execution-failed' };

          expect(result).toEqual({
            bad: { first: failed, counted: failed, filtered: failed },
            fine: { first: failed, counted: failed, filtered: failed },
          });
        },
      );

      it.runIf(options.malformed?.length)(
        'does not read dates that do not participate',
        async () => {
          const result = await compute(
            [
              ['bad', options.malformed?.[0] ?? null],
              ['fine', '2026-10-01'],
            ],
            { rows: sql('COUNT(*)') },
          );

          expect(result).toEqual({
            bad: { rows: { value: '1' } },
            fine: { rows: { value: '1' } },
          });
        },
      );
    },
  );
}
