import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRuntime } from '@relate/node';
import type { QueryResult, ObjectRecord } from '@relate/protocol';
import { connect, implementAction } from 'relate';
import type { ActionContext } from 'relate';
import type { ObservationStore } from '@relate/runtime/storage';
import { SourceAccessDenied } from 'relate/connectors';
import { createQueryModel } from './query-model.js';

export function queryContract(
  name: string,
  open: () => Promise<{ store: ObservationStore; close(): Promise<void> }>,
) {
  describe(name, () => {
    let backing: Awaited<ReturnType<typeof open>>;
    let model: ReturnType<typeof createQueryModel>;
    let now: number;
    let offline: boolean;
    let denied: boolean;
    let onFetch: (() => void) | undefined;
    let account: string;
    let graphId: string;
    let records: Map<
      string,
      {
        id: string;
        customer: string;
        status?: string;
        total: number | null;
        paid: boolean;
      }
    >;
    let portfolios: Map<string, string>;
    let app: ReturnType<
      typeof createRuntime<ReturnType<typeof createQueryModel>['graph']>
    >;
    const actor = {
      id: 'ana',
      roles: ['employee'],
      claims: { portfolio: 'north' },
    };
    const fin = { ...actor, roles: ['employee', 'finance'] };

    type Context = ActionContext<
      ReturnType<typeof createQueryModel>['graph'],
      ReturnType<typeof createQueryModel>['Run']
    >;

    let handler: (context: Context) => Promise<{ count: number }>;
    const start = (store = backing.store) =>
      createRuntime({
        graph: model.graph,
        graphId,
        store,
        clock: () => now,
        cursorKey: new Uint8Array(32).fill(7),
        actionImplementations: [
          implementAction(model.graph, model.Run, (context) =>
            handler(context),
          ),
        ],
        connections: [
          connect(model.customers, {
            connectionId: 'crm',
            providerAccountId: 'account',
            connector: {
              identify: async () => account,
              fetch: async (id) => {
                if (offline) throw new Error('offline');

                return {
                  providerAccountId: account,
                  state: 'present',
                  record: { id, portfolio: portfolios.get(id) ?? 'north' },
                };
              },
            },
          }),
          connect(model.invoices, {
            connectionId: 'billing',
            providerAccountId: 'account',
            connector: {
              identify: async () => account,
              fetch: async (id) => {
                if (denied) throw new SourceAccessDenied();

                if (offline) throw new Error('offline');

                onFetch?.();
                const record = records.get(id);

                return record
                  ? { providerAccountId: account, state: 'present', record }
                  : { providerAccountId: account, state: 'deleted' };
              },
            },
          }),
        ],
      });

    async function seed(
      id: string,
      status: string | undefined = 'Overdue',
      customer = 'north',
      total: number | null = 10,
    ) {
      records.set(id, {
        id,
        customer,
        ...(status !== undefined ? { status } : {}),
        total,
        paid: false,
      });

      return app.host.adopt(model.Invoice, id);
    }

    beforeEach(async () => {
      backing = await open();
      model = createQueryModel();
      now = 1000;
      offline = false;
      denied = false;
      onFetch = undefined;
      account = 'account';
      graphId = randomUUID();
      records = new Map();
      portfolios = new Map();
      handler = async () => ({ count: 0 });
      app = start();
    });
    afterEach(async () => {
      await app?.close();
      await backing?.close();
    });

    it('enumerates only graph members, supports AND equality and reference IDs, and preserves selection evidence', async () => {
      const customer = await app.host.adopt(model.Customer, 'north');
      const overdue = await seed('a');

      await seed('b', 'Paid');
      records.set('not-adopted', {
        id: 'not-adopted',
        customer: 'north',
        status: 'Overdue',
        total: 20,
        paid: false,
      });
      const page = await app.as(actor).objects.Invoice.query({
        where: { customer, status: 'Overdue', paid: false },
        select: ['status'],
        limit: 1,
      });

      expect(page.data).toHaveLength(1);
      expect(page.data[0]).toMatchObject({
        id: overdue,
        data: { status: 'Overdue' },
        meta: {
          completeness: 'complete',
          fields: { status: { status: 'available', source: 'source' } },
        },
      });
      expect(Object.keys(page.data[0]!.meta.fields)).toEqual(['status']);
      expect((await app.as(actor).objects.Invoice.query()).data).toHaveLength(
        2,
      );
      expect(
        (
          await app
            .as(actor)
            .objects.Invoice.query({ where: { id: overdue }, select: [] })
        ).data.map((r) => r.id),
      ).toEqual([overdue]);
      const all = [];

      for await (const invoice of app
        .as(actor)
        .objects.Invoice.query({ limit: 1 }))
        all.push(invoice.id);

      expect(new Set(all).size).toBe(2);
    });

    it('validates filters even for empty graphs and rejects forbidden probes without scanning', async () => {
      const scan = vi.spyOn(backing.store, 'scan');

      for (const request of [
        { where: { total: 10 } },
        { where: { status: 42 } },
        { where: { typo: 'x' } },
        { where: { status: undefined } },
        { where: { status: { eq: 'Overdue' } } },
        { where: null },
        { where: [] },
        { limit: 0 },
        { limit: 101 },
        { cursor: '' },
        { sort: 'status' },
      ])
        await expect(
          async () =>
            await app.as(actor).objects.Invoice.query(request as never),
        ).rejects.toMatchObject({ code: 'invalid-request' });

      expect(scan).not.toHaveBeenCalled();
    });

    it('handles null and known absence without confusing them with unavailable filter evidence', async () => {
      records.set('absent', {
        id: 'absent',
        customer: 'north',
        total: null,
        paid: false,
      });
      await app.host.adopt(model.Invoice, 'absent');
      expect(
        (
          await app
            .as(fin)
            .objects.Invoice.query({ where: { total: null }, select: [] })
        ).data,
      ).toHaveLength(1);
      expect(
        (
          await app
            .as(actor)
            .objects.Invoice.query({ where: { status: 'Overdue' } })
        ).data,
      ).toEqual([]);
      await seed('present');
      now += 61_000;
      offline = true;
      await expect(
        app.as(actor).objects.Invoice.query({
          where: { status: 'Overdue' },
          stale: 'omit',
          select: [],
        }),
      ).rejects.toMatchObject({ code: 'incomplete' });
      expect(
        (
          await app.as(actor).objects.Invoice.query({
            where: { status: 'Overdue' },
            stale: 'allow',
            select: ['status'],
          })
        ).data[0]?.meta.fields.status,
      ).toMatchObject({ freshness: 'stale' });
    });

    it('refreshes a matched member whose filter evidence expires before the page is emitted', async () => {
      await seed('a');
      await seed('b');
      await seed('c');
      now += 61_000;
      let fetches = 0;

      // Action reads are sequential. Slow later refreshes leave each record fresh
      // when evaluated, but a and b are stale by the time the page is emitted.
      onFetch = () => {
        if (++fetches === 2 || fetches === 3) now += 40_000;
      };
      handler = async ({ objects }) => ({
        count: (
          await objects.Invoice.query({
            where: { status: 'Overdue' },
            stale: 'omit',
            select: [],
          })
        ).data.length,
      });
      const receipt = await app
        .as(actor)
        .actions.run({ input: {}, idempotencyKey: 'expiring' });

      expect(receipt.output.count).toBe(3);
      // Three first-pass refreshes, then one each for the expired a and b.
      expect(fetches).toBe(5);
    });

    it('does not disclose hidden references through filters or return denied or deleted source records', async () => {
      portfolios.set('south', 'south');
      const south = await app.host.adopt(model.Customer, 'south');

      await seed('a', 'Overdue', 'south');
      await expect(
        app
          .as(actor)
          .objects.Invoice.query({ where: { customer: south }, select: [] }),
      ).rejects.toMatchObject({ code: 'incomplete' });
      denied = true;
      expect(
        (await app.as(actor).objects.Invoice.query({ refresh: true })).data,
      ).toEqual([]);
      denied = false;
      records.clear();
      expect(
        (await app.as(actor).objects.Invoice.query({ refresh: true })).data,
      ).toEqual([]);
    });

    it('rechecks object access on subsequent pages and binds cursors to caller, filters, type and options', async () => {
      await app.host.adopt(model.Customer, 'a');
      await app.host.adopt(model.Customer, 'b');
      const request = { select: ['portfolio'] as const, limit: 1 };
      const page = await app.as(actor).objects.Customer.query(request);

      expect(page.meta.exhausted).toBe(false);
      const cursor = page.meta.continuationCursor!;

      for (const options of [
        { ...request, where: { portfolio: 'north' } },
        { ...request, select: [] },
        { ...request, limit: 2 },
      ])
        await expect(
          app.as(actor).objects.Customer.query({ ...options, cursor }),
        ).rejects.toMatchObject({ code: 'invalid-request' });

      await expect(
        app.as(fin).objects.Customer.query({ ...request, cursor }),
      ).rejects.toMatchObject({ code: 'invalid-request' });
      await expect(
        app.as(actor).objects.Invoice.query({ limit: 1, cursor }),
      ).rejects.toMatchObject({ code: 'invalid-request' });
      await expect(
        app
          .as(actor)
          .objects.Customer.query({ ...request, cursor: cursor + 'x' }),
      ).rejects.toMatchObject({ code: 'invalid-request' });
      portfolios.set('a', 'south');
      portfolios.set('b', 'south');
      now += 31_000;
      expect(
        (await app.as(actor).objects.Customer.query({ ...request, cursor }))
          .data,
      ).toEqual([]);
      now += 900_000;
      await expect(
        app.as(actor).objects.Customer.query({ ...request, cursor }),
      ).rejects.toMatchObject({ code: 'invalid-request' });
    });

    it('bounds scans and iterates through empty non-final pages', async () => {
      for (let i = 0; i < 101; i++) await seed(String(i), 'Paid');

      const first = await app
        .as(actor)
        .objects.Invoice.query({ where: { status: 'Overdue' }, select: [] });

      expect(first).toMatchObject({ data: [], meta: { exhausted: false } });
      const values = [];

      for await (const row of app
        .as(actor)
        .objects.Invoice.query({ where: { status: 'Overdue' }, select: [] }))
        values.push(row);

      expect(values).toEqual([]);
      const last = await app.as(actor).objects.Invoice.query({
        where: { status: 'Overdue' },
        select: [],
        cursor: first.meta.continuationCursor!,
      });

      expect(last.meta.exhausted).toBe(true);
    });

    it('preserves cursors across runtimes with the same key and isolates graph instances', async () => {
      await seed('a');
      await seed('b');
      handler = async ({ objects }) => {
        await objects.Review.create({ note: 'persisted' });

        return { count: 1 };
      };
      await app.as(actor).actions.run({ input: {}, idempotencyKey: 'create' });
      const first = await app.as(actor).objects.Invoice.query({ limit: 1 });

      await app.close();
      app = start();
      const next = await app.as(actor).objects.Invoice.query({
        limit: 1,
        cursor: first.meta.continuationCursor!,
      });

      expect(next.data).toHaveLength(1);
      expect(next.data[0]!.id).not.toBe(first.data[0]!.id);
      expect(
        (await app.as(actor).objects.Review.query()).data[0]?.data.note,
      ).toBe('persisted');
      await app.close();
      graphId = randomUUID();
      app = start();
      expect((await app.as(actor).objects.Invoice.query()).data).toEqual([]);
      expect((await app.as(actor).objects.Review.query()).data).toEqual([]);
      await expect(
        app.as(actor).objects.Invoice.query({
          limit: 1,
          cursor: first.meta.continuationCursor!,
        }),
      ).rejects.toMatchObject({ code: 'invalid-request' });
    });

    it('does not serve retained records after provider account verification changes', async () => {
      await seed('a');
      account = 'different-account';
      expect(
        (
          await app
            .as(actor)
            .objects.Invoice.query({ where: { status: 'Overdue' } })
        ).data,
      ).toEqual([]);
    });

    it('applies completeness only to matching projections and preserves explicit forbidden evidence', async () => {
      await seed('a');
      const partial = await app.as(actor).objects.Invoice.query({
        where: { status: 'Overdue' },
        select: ['total'],
      });

      expect(partial.data[0]?.meta.fields.total).toEqual({
        status: 'forbidden',
      });
      await expect(
        app.as(actor).objects.Invoice.query({
          where: { status: 'Overdue' },
          select: ['total'],
          requireComplete: true,
        }),
      ).rejects.toMatchObject({ code: 'incomplete' });
      expect(
        (
          await app.as(actor).objects.Invoice.query({
            where: { status: 'Paid' },
            select: ['total'],
            requireComplete: true,
          })
        ).data,
      ).toEqual([]);
      expect(
        (
          await app.as(actor).objects.Invoice.query({
            where: { status: 'Overdue' },
            select: [],
            requireComplete: true,
          })
        ).data,
      ).toHaveLength(1);
    });

    it('captures request values before lazy execution and rejects use after closing', async () => {
      await seed('a');
      const request = {
        where: { status: 'Overdue' },
        select: ['status'] as const,
      };
      const handle = app.as(actor).objects.Invoice.query(request);

      request.where.status = 'Paid';
      expect((await handle).data).toHaveLength(1);
      const late = app.as(actor).objects.Invoice.query();

      await app.close();
      await expect(late).rejects.toThrow('Relate is closed');
    });

    it('enumerates native records inside and outside actions with typed filters and pagination', async () => {
      handler = async ({ objects }) => {
        await objects.Review.create({ note: 'first' });
        await objects.Review.create({ note: 'second' });
        const rows = [];

        for await (const row of objects.Review.query({ limit: 1 }))
          rows.push(row);

        expect(
          (
            await objects.Review.query({
              where: { note: 'first' },
              select: ['note'],
            })
          ).data,
        ).toHaveLength(1);

        return { count: rows.length };
      };
      expect(
        await app
          .as(actor)
          .actions.run({ input: {}, idempotencyKey: 'create' }),
      ).toMatchObject({ output: { count: 2 } });
      const rows = [];

      for await (const row of app.as(actor).objects.Review.query({ limit: 1 }))
        rows.push(row);

      expect(rows).toHaveLength(2);
      expect(
        (
          await app.as(actor).objects.Review.query({
            where: { id: rows[0]!.id },
            select: ['note'],
          })
        ).data,
      ).toHaveLength(1);
      expect(
        (await app.as({ ...actor, roles: [] }).objects.Review.query()).data,
      ).toEqual([]);
    });

    it('rolls back native writes when a later query page fails, even if caught by the handler', async () => {
      await seed('a');
      await seed('b');
      handler = async ({ objects }) => {
        await objects.Review.create({ note: 'rollback' });
        const original = backing.store.scan.bind(backing.store);
        const scan = vi.spyOn(backing.store, 'scan');

        // Delegate the first page, fail on the next actual storage request.
        scan
          .mockImplementationOnce(original)
          .mockRejectedValueOnce(new Error('storage failed'));

        try {
          for await (const _ of objects.Invoice.query({ limit: 1 })) {
            /* consume */
          }
        } catch {
          /* executor must still abort */
        }

        return { count: 0 };
      };
      await expect(
        app.as(actor).actions.run({ input: {}, idempotencyKey: 'rollback' }),
      ).rejects.toMatchObject({ code: 'unavailable' });
      expect((await app.as(actor).objects.Review.query()).data).toEqual([]);
    });

    it('retains filter dependencies for receipt recovery even when fields are not selected', async () => {
      await seed('a');
      handler = async ({ objects }) => ({
        count: (
          await objects.Invoice.query({ where: { total: 10 }, select: [] })
        ).data.length,
      });
      const receipt = await app
        .as(fin)
        .actions.run({ input: {}, idempotencyKey: 'count' });

      expect(receipt.output.count).toBe(1);
      await expect(
        app.as(actor).receipts.get(model.Run, receipt.invocationId),
      ).rejects.toMatchObject({ code: 'denied' });
    });

    it('rejects action cursors and retained handles outside their original invocation', async () => {
      let cursor = '';
      let retained: QueryResult<ObjectRecord> | undefined;

      handler = async ({ objects }) => {
        await objects.Review.create({ note: 'a' });
        await objects.Review.create({ note: 'b' });
        cursor = (await objects.Review.query({ limit: 1 })).meta
          .continuationCursor!;
        retained = objects.Review.query();

        return { count: 2 };
      };
      await app.as(actor).actions.run({ input: {}, idempotencyKey: 'one' });
      await expect(
        app.as(actor).objects.Review.query({ limit: 1, cursor }),
      ).rejects.toMatchObject({ code: 'invalid-request' });
      await expect(retained!).rejects.toMatchObject({ code: 'invalid' });
      handler = async ({ objects }) => ({
        count: (await objects.Review.query({ limit: 1, cursor })).data.length,
      });
      await expect(
        app.as(actor).actions.run({ input: {}, idempotencyKey: 'two' }),
      ).rejects.toMatchObject({ code: 'internal' });
    });

    it('rejects a store that repeats its scan position and stops requesting pages on early exit', async () => {
      await seed('a');
      await seed('b');
      const scan = vi.spyOn(backing.store, 'scan');

      for await (const _ of app.as(actor).objects.Invoice.query({ limit: 1 }))
        break;

      expect(scan).toHaveBeenCalledTimes(1);
      const batch = await scan.mock.results[0]!.value;

      scan.mockResolvedValue({ ...batch, hasMore: true });
      const first = await app.as(actor).objects.Invoice.query({ limit: 1 });

      await expect(
        app.as(actor).objects.Invoice.query({
          limit: 1,
          cursor: first.meta.continuationCursor!,
        }),
      ).rejects.toMatchObject({ code: 'incomplete' });
    });
  });
}
