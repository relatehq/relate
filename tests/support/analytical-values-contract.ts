import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  bind,
  computed,
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
import type { ObjectQueryRequest } from '@relate/protocol';
import { testCreation } from './activity.js';

export interface AnalyticalValuesInput {
  readonly events: readonly (readonly [
    string,
    string,
    string | null,
    bigint | null,
    string | null,
  ])[];
  readonly invoices: readonly (readonly [string, string, bigint])[];
}

export interface AnalyticalValuesBackend {
  readonly events: AnalyticalResource;
  readonly invoices: AnalyticalResource;
  close(): Promise<void>;
}

const expressions = {
  eventCount: 'SELECT COUNT(*) FROM self.events',
  nonnullCount: 'SELECT COUNT(amount) FROM self.events',
  distinctUsers: 'SELECT COUNT(DISTINCT userId) FROM self.events',
  total: 'SELECT SUM(amount) FROM self.events',
  average: 'SELECT AVG(amount) FROM self.events',
  minimum: 'SELECT MIN(amount) FROM self.events',
  maximum: 'SELECT MAX(amount) FROM self.events',
  lastEvent: 'SELECT MAX(occurredAt) FROM self.events',
  since: 'SELECT COUNT(*) FROM self.events WHERE occurredAt >= self.since',
  invoiceCount: 'SELECT COUNT(*) FROM self.invoices',
  invoiceTotal: 'SELECT SUM(amount) FROM self.invoices',
  numeric: 'SELECT COUNT(*) FROM self.events WHERE 2 < 10',
  wideOr: 'SELECT COUNT(*) FROM self.events WHERE amount = -1 OR 1 = 1',
} as const;

function createGraph(declared: boolean, reversePairs: boolean) {
  const access = defineAccess({
    roles: ['reader', 'analyst', 'identifying'],
    fieldGroups: ['ordinary', 'identifying'],
    claims: { region: z.string() },
  });
  const column = <T extends z.ZodType>(id: string, schema: T) => ({
    id,
    schema,
    access: access.groups.ordinary,
  });
  const Events = defineDataset({
    id: 'events',
    columns: {
      customerId: column('events.customer', z.string()),
      region: column('events.region', z.string()),
      userId: {
        id: 'events.user',
        schema: z.string().nullable(),
        access: access.groups.identifying,
      },
      amount: column('events.amount', z.int64().nullable()),
      occurredAt: column(
        'events.at',
        z.iso.datetime({ offset: true, precision: 3 }).nullable(),
      ),
    },
  });
  const Invoices = defineDataset({
    id: 'invoices',
    columns: {
      customerId: column('invoices.customer', z.string()),
      region: column('invoices.region', z.string()),
      amount: column('invoices.amount', z.int64()),
    },
  });
  const pairs = [
    { column: 'customerId', property: 'externalId' },
    { column: 'region', property: 'region' },
  ] as const;
  const Customer = defineObject({
    id: 'customer',
    membership: nativeMembership(),
    properties: {
      id: objectId({ id: 'customer.id' }),
      externalId: native(z.string(), { id: 'customer.external' }),
      region: native(z.string(), { id: 'customer.region' }),
      since: native(z.iso.datetime({ offset: true, precision: 3 }), {
        id: 'customer.since',
      }),
      ...(declared
        ? Object.fromEntries(
            Object.entries(expressions).map(([name, sql]) => [
              name === 'since' ? 'sinceCount' : name,
              computed({ id: `customer.calculation.${name}`, sql }),
            ]),
          )
        : {}),
    },
    datasets: {
      events: {
        id: 'customer.events',
        dataset: Events,
        on: reversePairs ? ([pairs[1], pairs[0]] as const) : pairs,
      },
      invoices: {
        id: 'customer.invoices',
        dataset: Invoices,
        on: reversePairs ? pairs : ([pairs[1], pairs[0]] as const),
      },
    },
  });
  const graph = defineGraph({
    id: 'values',
    access,
    objects: { Customer },
    datasets: { Events, Invoices },
    policies: {
      Customer: {
        read: {
          gate: access.role('reader'),
          where: { region: { eq: access.claims.region } },
          evidenceMaxAgeMs: 30_000,
        },
        datasets: {
          events: { gate: access.role('analyst') },
          invoices: { gate: access.role('analyst') },
        },
      },
      Events: { groups: { identifying: access.role('identifying') } },
      Invoices: {},
    },
  });

  return { graph, Events, Invoices };
}

/** Both real backends execute the same public-host values and authorization contract. */
export function analyticalValuesContract(
  name: string,
  open: (input: AnalyticalValuesInput) => Promise<AnalyticalValuesBackend>,
) {
  describe(name, () => {
    const cleanup: (() => Promise<void>)[] = [];

    afterEach(async () => {
      for (const close of cleanup.splice(0).reverse()) await close();
    });

    async function fixture(
      declared: boolean,
      batchSize = 64,
      reversePairs = false,
    ) {
      const { graph, Events, Invoices } = createGraph(declared, reversePairs);
      const first = '2026-10-01T00:00:00.000Z';
      const last = '2026-10-09T00:00:00.000Z';
      const backend = await open({
        events: [
          ['shared', 'north', 'u1', 10n, first],
          ['shared', 'north', 'u1', 10n, first], // Identical rows are meaningful.
          ['shared', 'north', null, null, last],
          ['shared', 'south', 'secret', 999n, last],
          ['nulls', 'north', null, null, null],
          ['wide', 'north', 'u1', 9007199254740993n, first],
          ['wide', 'north', 'u2', 2n, last],
        ],
        invoices: [
          ['shared', 'north', 7n],
          ['shared', 'north', 11n],
          ['shared', 'south', 999n],
        ],
      });

      cleanup.push(() => backend.close());
      expect(backend.events.connection).toBe(backend.invoices.connection);
      const base = backend.events.connection;
      const counters = { statements: 0 };
      const connection = {
        ...base,
        analytics: {
          ...base.analytics,
          execute(...args: Parameters<typeof base.analytics.execute>) {
            counters.statements++;

            return base.analytics.execute(...args);
          },
        },
      };
      const store = createMemoryStore();
      const model = compile(graph);
      const scope = {
        graphId: graph.id,
        definitionRevision: model.definitionRevision,
      };

      await store.install(scope.graphId, scope.definitionRevision);
      await store.native!.transaction(scope, async (transaction) => {
        for (const [id, key, region, since] of [
          ['a', 'shared', 'north', first],
          ['b', 'shared', 'north', last],
          ['empty', 'empty', 'north', first],
          ['nulls', 'nulls', 'north', first],
          ['wide', 'wide', 'north', first],
          ['hidden', 'shared', 'south', first],
        ])
          await transaction.insert(
            {
              objectDefinitionId: 'customer',
              objectId: id!,
              createdAt: 1,
              values: {
                'customer.external': key!,
                'customer.region': region!,
                'customer.since': since!,
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
            analytics: { maxExpressions: 16, maxKeysPerStatement: batchSize },
            bindings: [
              bind(Events, { ...backend.events, connection }),
              bind(Invoices, { ...backend.invoices, connection }),
            ],
          }),
        }),
      );

      cleanup.push(() => runtime.close());
      const principal = {
        id: 'ana',
        roles: ['reader', 'analyst', 'identifying'],
        claims: { region: 'north' },
      };
      const names = Object.keys(expressions).map((name) =>
        name === 'since' ? 'sinceCount' : name,
      );
      const request: ObjectQueryRequest = declared
        ? { select: names }
        : {
            select: [],
            compute: Object.fromEntries(
              Object.entries(expressions).map(([name, sql]) => [
                name === 'since' ? 'sinceCount' : name,
                { sql },
              ]),
            ),
          };

      return { runtime, principal, request, counters, store };
    }

    for (const declared of [false, true]) {
      describe(declared ? 'declared properties' : 'caller expressions', () => {
        it.each([1, 2, 10])(
          'keeps multi-association computed ordering and values stable across page size %i',
          async (limit) => {
            const { runtime, principal, request } = await fixture(declared, 2);
            const actor = runtime.operations(principal);
            const ordered: ObjectQueryRequest = {
              ...request,
              where: { eventCount: { gte: '0' } },
              orderBy: [
                { field: 'invoiceTotal', direction: 'desc' },
                { field: 'sinceCount', direction: 'desc' },
              ],
              limit,
            };
            const rows = [];
            let cursor: string | undefined;

            do {
              const page = await actor.query('customer', {
                ...ordered,
                ...(cursor ? { cursor } : {}),
              });

              rows.push(...page.data);
              cursor = page.meta.continuationCursor;
              expect(rows.length).toBeLessThanOrEqual(5);
            } while (cursor);

            expect(rows.map((row) => row.id)).toEqual([
              'a',
              'b',
              'wide',
              'empty',
              'nulls',
            ]);
            expect(rows[0]!.data).toMatchObject({
              eventCount: '3',
              invoiceCount: '2',
              invoiceTotal: '18',
              sinceCount: '3',
            });
            expect(rows[1]!.data).toMatchObject({
              eventCount: '3',
              invoiceCount: '2',
              invoiceTotal: '18',
              sinceCount: '1',
            });
            const zeros = await actor.query('customer', {
              ...request,
              where: { eventCount: { eq: '0' }, invoiceCount: { eq: '0' } },
            });

            expect(zeros.data.map((row) => row.id)).toEqual(['empty']);
          },
        );

        it('masks only the expression using an unavailable self dependency', async () => {
          const { runtime, principal, request, counters, store } =
            await fixture(declared);
          const original = store.native!.load.bind(store.native!);

          store.native!.load = async (...args) => {
            const record = await original(...args);

            if (record?.objectId !== 'b') return record;

            const values = { ...record.values };

            delete values['customer.since'];

            return { ...record, values };
          };
          const actor = runtime.operations(principal);
          const page = await actor.query('customer', {
            ...request,
            evidence: 'full',
          });
          const row = page.data.find((entry) => entry.id === 'b')!;

          expect(row.data).not.toHaveProperty('sinceCount');
          expect(row.data).toMatchObject({
            eventCount: '3',
            total: '20',
            invoiceCount: '2',
            invoiceTotal: '18',
          });
          expect(row.meta.fields?.sinceCount).toMatchObject({
            status: 'unavailable',
            reason: 'correlation-unavailable',
          });
          expect(counters.statements).toBe(2);
          await expect(
            actor.query('customer', { ...request, requireComplete: true }),
          ).rejects.toMatchObject({
            code: 'incomplete',
            issues: [
              { path: ['sinceCount'], message: 'correlation-unavailable' },
            ],
          });
        });

        it.each([1, 2, 64])(
          'preserves grain, composite scope and per-object dependencies with batch size %i',
          async (batchSize) => {
            const { runtime, principal, request, counters } = await fixture(
              declared,
              batchSize,
              batchSize === 2,
            );
            const page = await runtime
              .operations(principal)
              .query('customer', { ...request, evidence: 'full', limit: 20 });

            expect(page.data.map((row) => row.id)).toEqual([
              'a',
              'b',
              'empty',
              'nulls',
              'wide',
            ]);
            expect(counters.statements).toBe(2 * Math.ceil(5 / batchSize));
            const shared = {
              eventCount: '3',
              nonnullCount: '2',
              distinctUsers: '1',
              total: '20',
              average: 10,
              minimum: '10',
              maximum: '10',
              lastEvent: '2026-10-09T00:00:00.000Z',
              invoiceCount: '2',
              invoiceTotal: '18',
              numeric: '3',
              wideOr: '3',
            };

            expect(page.data[0]!.data).toEqual({ ...shared, sinceCount: '3' });
            expect(page.data[1]!.data).toEqual({ ...shared, sinceCount: '1' });
            const empty = {
              eventCount: '0',
              nonnullCount: '0',
              distinctUsers: '0',
              total: null,
              average: null,
              minimum: null,
              maximum: null,
              lastEvent: null,
              sinceCount: '0',
              invoiceCount: '0',
              invoiceTotal: null,
              numeric: '0',
              wideOr: '0',
            };

            expect(page.data[2]!.data).toEqual(empty);
            expect(page.data[3]!.data).toEqual({
              ...empty,
              eventCount: '1',
              numeric: '1',
              wideOr: '1',
            });
            expect(page.data[4]!.data).toEqual({
              eventCount: '2',
              nonnullCount: '2',
              distinctUsers: '2',
              total: '9007199254740995',
              average: 4503599627370498,
              minimum: '2',
              maximum: '9007199254740993',
              lastEvent: '2026-10-09T00:00:00.000Z',
              sinceCount: '2',
              invoiceCount: '0',
              invoiceTotal: null,
              numeric: '2',
              wideOr: '2',
            });

            for (const row of page.data) {
              expect(row.meta.computed).toMatchObject({
                eventCount: { type: 'int64', nullable: false },
                total: { type: 'int64', nullable: true },
                lastEvent: { type: 'timestamp', precision: 3, nullable: true },
              });
              expect(row.meta.fields?.eventCount).toMatchObject({
                status: 'available',
                source: 'computed',
                freshness: 'unverified',
                inputs: [
                  { associationId: 'customer.events', datasetId: 'events' },
                ],
              });
              expect(row.meta.fields?.invoiceTotal).toMatchObject({
                status: 'available',
                inputs: [
                  { associationId: 'customer.invoices', datasetId: 'invoices' },
                ],
              });
              expect(row.data).not.toHaveProperty('externalId');
              expect(row.data).not.toHaveProperty('region');
            }

            const compact = await runtime
              .operations(principal)
              .get('customer', 'a', { ...request, evidence: 'compact' });

            expect(compact.status).toBe('ok');

            if (compact.status === 'ok') {
              expect(compact.data).toEqual(page.data[0]!.data);
              expect(compact.meta.computed).toEqual(
                page.data[0]!.meta.computed,
              );
            }
          },
        );

        it('withholds restricted columns without withholding independent aggregates or leaking a hidden object', async () => {
          const { runtime, principal, request, counters } =
            await fixture(declared);
          const actor = runtime.operations({
            ...principal,
            roles: ['reader', 'analyst'],
          });
          const page = await actor.query('customer', request);

          for (const row of page.data) {
            expect(row.data).not.toHaveProperty('distinctUsers');
            expect(row.meta.fields?.distinctUsers).toEqual({
              status: 'forbidden',
            });
            expect(row.meta.fields?.eventCount?.status).toBe('available');
          }

          const before = counters.statements;

          expect(await actor.get('customer', 'hidden', request)).toMatchObject({
            status: 'not-found',
          });
          expect(counters.statements).toBe(before);
        });
      });
    }
  });
}
