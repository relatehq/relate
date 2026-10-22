import { afterEach, describe, expect, it } from 'vitest';
import { bind, defineApp } from 'relate';
import type { AnalyticalLimits } from 'relate/analytics';
import type { AnalyticalResource } from 'relate/connectors';
import { DatasetExecutionError } from 'relate/connectors';
import type { ObjectQueryRequest } from '@relate/protocol';
import { compile } from 'relate/compiler';
import { startApp } from '@relate/node';
import { createMemoryStore } from '@relate/runtime';
import { createAnalyticalGraph } from './analytical-graph.js';
import { testCreation } from './activity.js';

export interface AnalyticalOrderBackend {
  readonly resource: AnalyticalResource;
  close(): Promise<void>;
}

export interface AnalyticalOrderInput {
  readonly members: readonly (readonly [string, bigint | null])[];
  readonly secret: string;
  readonly connectionId: string;
}

/** The same public-host ordering contract runs with each real analytical backend. */
export function analyticalOrderContract(
  name: string,
  open: (input: AnalyticalOrderInput) => Promise<AnalyticalOrderBackend>,
) {
  describe(name, () => {
    const cleanup: (() => void | Promise<void>)[] = [];

    afterEach(async () => {
      for (const close of cleanup.splice(0).reverse()) await close();
    });

    async function app(
      options: {
        limits?: AnalyticalLimits;
        count?: number;
        declared?: string;
        connectionId?: string;
        missingKey?: string;
        secret?: string;
        clock?: () => number;
        resource?: AnalyticalResource;
      } = {},
    ) {
      const { graph, Customer, Events } = createAnalyticalGraph(
        options.declared,
      );
      const members: readonly (readonly [string, bigint | null])[] =
        options.count === undefined
          ? [
              ['a', 9n],
              ['b', 10n],
              ['c', 9007199254740993n],
              ['d', null],
              ['e', 9n],
            ]
          : Array.from(
              { length: options.count },
              (_, i) => [String(i).padStart(4, '0'), BigInt(i)] as const,
            );
      const backing = options.resource
        ? undefined
        : await open({
            members,
            secret: options.secret ?? 'private',
            connectionId: options.connectionId ?? 'events',
          });

      if (backing) cleanup.push(() => backing.close());

      const resource = options.resource ?? backing!.resource;
      const connection = resource.connection;
      const counters = { statements: 0, slots: 0, loads: 0 };
      const hooks: { afterExecute?: () => void; failAt?: number } = {};
      const bound = {
        ...resource,
        connection: {
          ...connection,
          analytics: {
            ...connection.analytics,
            plan(query: Parameters<typeof connection.analytics.plan>[0]) {
              counters.slots += query.slots.length;

              return connection.analytics.plan(query);
            },
            async execute(
              ...args: Parameters<typeof connection.analytics.execute>
            ) {
              counters.statements++;

              if (counters.statements === hooks.failAt)
                throw new DatasetExecutionError('execution-failed', {
                  retryable: true,
                });

              const result = await connection.analytics.execute(...args);

              hooks.afterExecute?.();

              return result;
            },
          },
        },
      };
      const model = compile(graph);
      const store = createMemoryStore();
      const scope = {
        graphId: graph.id,
        definitionRevision: model.definitionRevision,
      };

      await store.install(scope.graphId, scope.definitionRevision);
      await store.native!.transaction(scope, async (transaction) => {
        for (const [id] of members)
          await transaction.insert(
            {
              objectDefinitionId: Customer.id,
              objectId: id,
              createdAt: Date.now(),
              values: {
                ...(id === options.missingKey
                  ? {}
                  : { 'customer.external': id }),
                'customer.label': id === 'd' ? 'excluded' : 'included',
              },
            },
            testCreation(),
          );
      });
      const load = store.native!.load.bind(store.native!);

      store.native!.load = (...args) => {
        counters.loads++;

        return load(...args);
      };
      const runtime = await startApp(
        defineApp({
          graph,
          setup() {
            return {
              store,
              cursorKey: new Uint8Array(32).fill(9),
              ...(options.clock ? { clock: options.clock } : {}),
              ...(options.limits ? { analytics: options.limits } : {}),
              bindings: [bind(Events, bound)],
            };
          },
        }),
      );

      cleanup.push(() => runtime.close());
      const principal = {
        id: 'ana',
        roles: ['reader', 'analyst', 'private'],
        claims: {},
      };

      return {
        runtime,
        principal,
        counters,
        store,
        hooks,
        resource,
        consumer: runtime.as(principal).objects.Customer,
        query: (request: ObjectQueryRequest) =>
          runtime.operations(principal).query('customer', request),
      };
    }

    const compute = {
      total: { sql: 'SELECT SUM(amount) FROM self.events' },
    } as const;
    const ordered = {
      select: ['label'],
      compute,
      orderBy: [{ field: 'total', direction: 'desc' }],
      limit: 2,
    } as const;

    it('sorts the full scope exactly, keeps nulls last and pages without duplicates', async () => {
      const { consumer, counters } = await app();
      const rows = [];
      const request = consumer.query(ordered);

      for await (const row of request) rows.push(row);

      expect(rows.map((row) => [row.id, row.data.total])).toEqual([
        ['c', '9007199254740993'],
        ['b', '10'],
        ['a', '9'],
        ['e', '9'],
        ['d', null],
      ]);
      expect(counters.statements).toBe(3);
      expect(counters.slots).toBe(15);
      expect(rows.every((row) => !Object.hasOwn(row.data, 'externalId'))).toBe(
        true,
      );
    });

    it('uses ID ascending for ties and puts null last in ascending order too', async () => {
      const { consumer } = await app();
      const page = await consumer.query({
        ...ordered,
        limit: 100,
        orderBy: [{ field: 'total', direction: 'asc' }],
      });

      expect(page.data.map((row) => row.id)).toEqual(['a', 'e', 'b', 'c', 'd']);
    });

    it('computes beyond ordinary 100-member pages before choosing the top result', async () => {
      const { consumer, counters } = await app({ count: 201 });
      const page = await consumer.query({ ...ordered, limit: 1 });

      expect(page.data[0]?.id).toBe('0200');
      expect(counters.slots).toBe(201);
      expect(counters.statements).toBe(1);
    });

    it.each(['compact', 'full'] as const)(
      'combines filters and hides filter-only declarations with %s evidence',
      async (evidence) => {
        const { consumer, counters } = await app();
        const page = await consumer.query({
          select: ['label'],
          evidence,
          where: { label: 'included', count: { eq: '1' } },
          orderBy: [{ field: 'count', direction: 'desc' }],
        });

        expect(page.data.map((row) => row.id)).toEqual(['a', 'b', 'c', 'e']);
        expect(counters.slots).toBe(4);

        for (const row of page.data) {
          expect(row.data).toEqual({ label: 'included' });
          expect(row.meta.computed).toEqual({});
          expect(row.meta.fields ?? {}).not.toHaveProperty('count');
        }
      },
    );

    it.each([null, { eq: null }, { in: [null] }])(
      'computed null never matches %j',
      async (predicate) => {
        const { query } = await app();
        const page = await query({ ...ordered, where: { total: predicate } });

        expect(page.data).toEqual([]);
        expect(page.meta.exhausted).toBe(true);
      },
    );

    it('uses exact bounds and combines operator entries with AND', async () => {
      const { consumer } = await app();
      const page = await consumer.query({
        ...ordered,
        where: { total: { gte: '10', lt: '9007199254740993' } },
      });

      expect(page.data.map((row) => row.id)).toEqual(['b']);
    });

    it.each([
      { where: { total: { gt: 9 } } },
      { where: { total: { in: ['1', true] } } },
      { where: { total: { contains: '1' } } },
      { where: { total: { eq: '9223372036854775808' } } },
      { orderBy: [{ field: 'label', direction: 'asc' }] },
      { orderBy: [{ field: 'typo', direction: 'asc' }] },
      { orderBy: [{ field: 'total', direction: 'up' }] },
      { orderBy: [{ field: 'total', direction: 'asc', extra: true }] },
      {
        orderBy: [
          { field: 'total', direction: 'asc' },
          { field: 'total', direction: 'desc' },
        ],
      },
    ])(
      'validates computed comparisons and order before reads, including empty scope: %j',
      async (invalid) => {
        const { query, counters } = await app({ count: 0 });

        await expect(
          query({ ...ordered, ...invalid } as ObjectQueryRequest),
        ).rejects.toMatchObject({ code: 'invalid-request' });
        expect(counters).toEqual({ statements: 0, slots: 0, loads: 0 });
      },
    );

    it.each([{ maxCandidatesAdmitted: 4 }, { maxCandidatesScanned: 4 }])(
      'rejects an oversized scope before any SQL: %j',
      async (limits) => {
        const { consumer, counters } = await app({ limits });

        await expect(consumer.query(ordered)).rejects.toMatchObject({
          code: 'resource-exhausted',
          issues: [{ problem: 'limit-exceeded' }],
        });
        expect(counters.statements).toBe(0);
      },
    );

    it('counts scanned nonmatches independently of admitted candidates', async () => {
      const { consumer, counters } = await app({
        limits: { maxCandidatesScanned: 4, maxCandidatesAdmitted: 1 },
      });

      await expect(
        consumer.query({ ...ordered, where: { label: 'never' } }),
      ).rejects.toMatchObject({ code: 'resource-exhausted' });
      expect(counters.statements).toBe(0);
    });

    it('accepts the exact scope caps and applies them only to computed filter/order queries', async () => {
      const { consumer } = await app({
        limits: { maxCandidatesAdmitted: 5, maxCandidatesScanned: 5 },
      });

      expect((await consumer.query(ordered)).data.map((row) => row.id)).toEqual(
        ['c', 'b'],
      );
      const { consumer: ordinary } = await app({
        limits: { maxCandidatesAdmitted: 0, maxCandidatesScanned: 0 },
      });

      expect(
        (await ordinary.query({ select: ['count'], limit: 1 })).data,
      ).toHaveLength(1);
    });

    it('fails required fields even on objects that would fall outside the returned page', async () => {
      const { consumer } = await app({ missingKey: 'e' });

      await expect(
        consumer.query({ ...ordered, limit: 1, requireComplete: false }),
      ).rejects.toMatchObject({
        code: 'incomplete',
        issues: [{ path: ['total'], message: 'correlation-unavailable' }],
      });
    });

    it.each(['scope', 'page'] as const)(
      'invalidates changed dependencies during the %s recheck without recomputation',
      async (phase) => {
        const { consumer, store, counters } = await app();
        const native = store.native!;
        const original = native.load.bind(native);
        let afterSqlReads = 0;

        native.load = async (...args) => {
          const record = await original(...args);

          if (
            counters.statements &&
            record?.objectId === (phase === 'scope' ? 'e' : 'c')
          ) {
            afterSqlReads++;

            if (phase === 'scope' || afterSqlReads === 2)
              return {
                ...record,
                values: { ...record.values, 'customer.external': 'changed' },
              };
          }

          return record;
        };
        await expect(
          consumer.query({ ...ordered, limit: 1 }),
        ).rejects.toMatchObject({
          code: 'incomplete',
          issues: [{ path: ['total'], message: 'correlation-unavailable' }],
        });
        expect(counters.statements).toBe(1);
      },
    );

    it('withholds a no-longer-visible object after SQL instead of disclosing its calculation', async () => {
      const { consumer, store, counters } = await app();
      const original = store.native!.load.bind(store.native!);

      store.native!.load = async (...args) => {
        const record = await original(...args);

        return counters.statements && record?.objectId === 'c'
          ? undefined
          : record;
      };
      const page = await consumer.query(ordered);

      expect(page.data.map((row) => row.id)).toEqual(['b', 'a']);
    });

    it('binds encrypted positions to expressions, order, principal and bindings but not evidence mode', async () => {
      const fixture = await app();
      const first = await fixture.query(ordered);

      expect(first.meta.exhausted).toBe(false);

      if (first.meta.exhausted) return;

      const cursor = first.meta.continuationCursor!;
      const next = await fixture.query({
        ...ordered,
        cursor,
        evidence: 'full',
      });

      expect(next.data.map((row) => row.id)).toEqual(['a', 'e']);
      expect(cursor).not.toContain('9007199254740993');

      for (const request of [
        {
          ...ordered,
          cursor,
          compute: { total: { sql: 'SELECT COUNT(*) FROM self.events' } },
        },
        {
          ...ordered,
          cursor,
          orderBy: [{ field: 'total', direction: 'asc' as const }],
        },
        { ...ordered, cursor, where: { total: { gte: '0' } } },
      ])
        await expect(fixture.query(request)).rejects.toMatchObject({
          code: 'invalid-request',
          issues: [{ problem: 'invalid-cursor' }],
        });

      await expect(
        fixture.runtime
          .operations({ ...fixture.principal, id: 'bob' })
          .query('customer', { ...ordered, cursor }),
      ).rejects.toMatchObject({
        code: 'invalid-request',
        issues: [{ problem: 'invalid-cursor' }],
      });
      const other = await app({ connectionId: 'different' });

      await expect(other.query({ ...ordered, cursor })).rejects.toMatchObject({
        code: 'invalid-request',
        issues: [{ problem: 'invalid-cursor' }],
      });
    });

    it.each([false, true])(
      'applies requireComplete=%s to projected calculations across the evaluated scope',
      async (requireComplete) => {
        const { consumer, store } = await app();
        const original = store.native!.load.bind(store.native!);

        store.native!.load = async (...args) => {
          const record = await original(...args);

          if (record?.objectId !== 'e') return record;

          const { 'customer.label': _label, ...values } = record.values;

          return { ...record, values };
        };
        const result = consumer.query({
          ...ordered,
          select: [],
          limit: 1,
          requireComplete,
          compute: {
            ...compute,
            optional: {
              sql: 'SELECT COUNT(*) FROM self.events WHERE customerId = self.label',
            },
          },
        });

        if (requireComplete)
          await expect(result).rejects.toMatchObject({
            code: 'incomplete',
            issues: [
              { path: ['optional'], message: 'correlation-unavailable' },
            ],
          });
        else expect((await result).data.map((row) => row.id)).toEqual(['c']);
      },
    );

    it('rejects an oversized continuation instead of returning a cursor that cannot be resumed', async () => {
      const { consumer } = await app({ secret: 'large'.repeat(2000) });

      await expect(
        consumer.query({
          select: [],
          compute: { value: { sql: 'SELECT MIN(secret) FROM self.events' } },
          orderBy: [{ field: 'value', direction: 'asc' }],
          limit: 1,
        }),
      ).rejects.toMatchObject({
        code: 'invalid-request',
        issues: [{ path: ['cursor'], problem: 'not-supported' }],
      });
    });

    it('uses the configured batch size for real full-scope ordering', async () => {
      const { consumer, counters } = await app({
        limits: { maxKeysPerStatement: 2, maxConcurrentStatements: 1 },
      });
      const page = await consumer.query({ ...ordered, limit: 5 });

      expect(page.data.map((row) => row.id)).toEqual(['c', 'b', 'a', 'e', 'd']);
      expect(counters.slots).toBe(5);
      expect(counters.statements).toBe(3);
    });

    it.each(['caller', 'declared'] as const)(
      '%s filtering fails on a later batch even when the first batch could fill the page',
      async (form) => {
        const fixture = await app({
          declared: 'SELECT SUM(amount) FROM self.events',
          limits: { maxKeysPerStatement: 2, maxConcurrentStatements: 1 },
        });
        const field = form === 'caller' ? 'total' : 'count';
        const request: ObjectQueryRequest = {
          select: ['label'],
          ...(form === 'caller' ? { compute } : {}),
          where: { [field]: { gte: '1' } },
          orderBy: [{ field, direction: 'desc' }],
          limit: 1,
          requireComplete: false,
        };

        fixture.hooks.failAt = 2;
        await expect(fixture.query(request)).rejects.toMatchObject({
          code: 'incomplete',
          issues: [{ path: [field], message: 'execution-failed' }],
        });
        expect(fixture.counters.statements).toBeGreaterThanOrEqual(2);
        await fixture.runtime.host.flushActivity();
        const failed = (
          await fixture.runtime.host.activity.operations.list()
        ).entries.find((row) => row.kind === 'query')!;

        expect(failed.details.analytical?.summary).toMatchObject({
          expressionCount: 1,
          computedFilter: true,
          computedOrder: true,
          calculations: [
            {
              associationId: 'customer.events',
              datasetId: 'events',
              failures: { 'execution-failed': 5 },
            },
          ],
        });
        delete fixture.hooks.failAt;
        const recovered = await fixture.query(request);

        expect(recovered.data.map((row) => row.id)).toEqual(['c']);
        expect(recovered.data[0]!.data).toEqual({
          label: 'included',
          ...(form === 'caller' ? { total: '9007199254740993' } : {}),
        });
      },
    );

    it.each(['caller', 'declared'] as const)(
      '%s ordering revalidates dependencies outside the returned page',
      async (form) => {
        const fixture = await app({
          declared: 'SELECT SUM(amount) FROM self.events',
        });
        const load = fixture.store.native!.load.bind(fixture.store.native!);
        const field = form === 'caller' ? 'total' : 'count';

        fixture.store.native!.load = async (...args) => {
          const record = await load(...args);

          return fixture.counters.statements && record?.objectId === 'e'
            ? {
                ...record,
                values: { ...record.values, 'customer.external': 'changed' },
              }
            : record;
        };
        await expect(
          fixture.query({
            select: ['label'],
            ...(form === 'caller' ? { compute } : {}),
            orderBy: [{ field, direction: 'desc' }],
            limit: 1,
          }),
        ).rejects.toMatchObject({
          code: 'incomplete',
          issues: [{ path: [field], message: 'correlation-unavailable' }],
        });
        expect(fixture.counters.statements).toBe(1);
      },
    );

    it('rejects changed parameters and expired analytical cursors before another statement', async () => {
      let now = Date.now();
      const fixture = await app({ clock: () => now });
      const request: ObjectQueryRequest = {
        ...ordered,
        compute: {
          total: {
            sql: 'SELECT SUM(amount) FROM self.events WHERE amount >= $minimum',
            parameters: { minimum: '1' },
          },
        },
      };
      const first = await fixture.query(request);
      const cursor = first.meta.continuationCursor!;

      expect(cursor).toBeDefined();
      const statements = fixture.counters.statements;

      await expect(
        fixture.query({
          ...request,
          cursor,
          compute: {
            total: {
              sql: 'SELECT SUM(amount) FROM self.events WHERE amount >= $minimum',
              parameters: { minimum: '10' },
            },
          },
        }),
      ).rejects.toMatchObject({
        code: 'invalid-request',
        issues: [{ problem: 'invalid-cursor' }],
      });
      now += 900_001;
      await expect(fixture.query({ ...request, cursor })).rejects.toMatchObject(
        {
          code: 'invalid-request',
          issues: [{ problem: 'invalid-cursor' }],
        },
      );
      expect(fixture.counters.statements).toBe(statements);
    });

    it('never restores an invalidated optional value or counts the final page recheck twice', async () => {
      const fixture = await app();
      const original = fixture.store.native!.load.bind(fixture.store.native!);
      let checked = 0;

      fixture.store.native!.load = async (...args) => {
        const record = await original(...args);

        if (
          fixture.counters.statements &&
          record?.objectId === 'c' &&
          ++checked === 1
        )
          return {
            ...record,
            values: { ...record.values, 'customer.label': 'changed' },
          };

        return record;
      };
      const page = await fixture.consumer.query({
        ...ordered,
        select: [],
        limit: 1,
        evidence: 'full',
        compute: {
          ...compute,
          optional: {
            sql: 'SELECT COUNT(*) FROM self.events WHERE customerId = self.label',
          },
        },
      });

      expect(checked).toBe(2);
      expect(page.data[0]!.data).toEqual({ total: '9007199254740993' });
      expect(page.data[0]!.meta.fields.optional).toMatchObject({
        status: 'unavailable',
        reason: 'correlation-unavailable',
      });
      await fixture.runtime.host.flushActivity();
      const row = (
        await fixture.runtime.host.activity.operations.list()
      ).entries.find((entry) => entry.kind === 'query')!;

      expect(
        row.details.analytical?.summary?.calculations.map(
          (entry) => entry.failures,
        ),
      ).toEqual([{}, { 'correlation-unavailable': 1 }]);
    });

    it('invalidates a cursor when declared SQL changes on the same physical binding', async () => {
      const fixture = await app();
      const request = {
        select: ['count'],
        orderBy: [{ field: 'count', direction: 'desc' }],
        limit: 1,
      } as const;
      const first = await fixture.query(request);
      const changed = await app({
        resource: fixture.resource,
        declared: 'SELECT SUM(amount) FROM self.events',
      });
      const current = await changed.query(request);

      expect(current.data[0]!.meta.definitionRevision).not.toBe(
        first.data[0]!.meta.definitionRevision,
      );
      expect(first.meta.continuationCursor).toBeDefined();
      const statements = changed.counters.statements;

      await expect(
        changed.query({ ...request, cursor: first.meta.continuationCursor! }),
      ).rejects.toMatchObject({
        code: 'invalid-request',
        issues: [{ problem: 'invalid-cursor' }],
      });
      expect(changed.counters.statements).toBe(statements);
    });

    it('rejects the default 10,001-member computed scope before executing any statement', async () => {
      const fixture = await app({ count: 10_001 });

      await expect(fixture.query(ordered)).rejects.toMatchObject({
        code: 'resource-exhausted',
        issues: [{ problem: 'limit-exceeded' }],
      });
      expect(fixture.counters.statements).toBe(0);
      expect(fixture.counters.slots).toBe(0);
    }, 30_000);
  });
}
