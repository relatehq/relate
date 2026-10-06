import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { connect, createRuntime } from '@relate/node';
import { SourceAccessDenied } from '@relate/runtime';
import type { SourceConnector } from '@relate/runtime';
import type { Mock } from 'vitest';
import { defineObject, defineRelationship, reference } from 'relate';
import { RetentionError } from '@relate/runtime/storage';
import type { ObservationStore } from '@relate/runtime/storage';
import {
  access,
  ana,
  finance,
  Customer,
  customers,
  Invoice,
  invoices,
  graph,
} from '../../dev/fixtures/customer-graph/invoice-read/model.js';

export function traversalContract(
  name: string,
  open: () => Promise<{ store: ObservationStore; close(): Promise<void> }>,
) {
  describe(name, () => {
    let backing: Awaited<ReturnType<typeof open>>;
    let now = 1000;
    const portfolios = new Map([
      ['north', 'north'],
      ['south', 'south'],
    ]);
    const records = new Map<
      string,
      { customer_id: string; status: string; total_minor: number }
    >();
    const unavailable = new Set<string>();
    const denied = new Set<string>();
    let relate: ReturnType<typeof createRuntime<typeof graph>>;
    let fetchInvoice: Mock<SourceConnector['fetch']>;
    const start = (model: typeof graph = graph) =>
      createRuntime({
        graph: model,
        graphId: randomUUID(),
        store: backing.store,
        clock: () => now,
        connections: [
          connect(customers, {
            connectionId: 'crm',
            connector: {
              async fetch(id) {
                if (unavailable.has(id)) throw new Error('offline');

                return {
                  state: 'present',
                  record: {
                    id,
                    name: id,
                    portfolio: portfolios.get(id) ?? 'north',
                    revenue: 50,
                  },
                };
              },
            },
          }),
          connect(invoices, {
            connectionId: 'billing',
            connector: { fetch: fetchInvoice },
          }),
        ],
      });

    beforeEach(async () => {
      backing = await open();
      now = 1000;
      portfolios.set('north', 'north');
      records.clear();
      unavailable.clear();
      denied.clear();
      fetchInvoice = vi.fn(async (id: string) => {
        if (unavailable.has(id)) throw new Error('offline');

        if (denied.has(id)) throw new SourceAccessDenied();

        const record = records.get(id);

        return record
          ? { state: 'present' as const, record: { id, ...record } }
          : { state: 'deleted' as const };
      });
      relate = start();
    });
    afterEach(async () => {
      await relate?.close();
      await backing?.close();
    });
    const adoptInvoice = async (sourceId: string, customer = 'north') => {
      records.set(sourceId, {
        customer_id: customer,
        status: 'open',
        total_minor: 12500,
      });

      return relate.host.adopt(Invoice, sourceId);
    };

    it('traverses both directions with canonical IDs and target field evidence', async () => {
      const customerId = await relate.host.adopt(Customer, 'north');
      const invoiceId = await adoptInvoice('inv_1');
      const objects = relate.as(ana).objects;
      const page = await objects.Customer.traverse.invoices(customerId, {
        select: ['status', 'totalMinor'],
      });

      expect(page.data).toHaveLength(1);
      expect(page.data[0]).toMatchObject({
        id: invoiceId,
        data: { status: 'open' },
        meta: { fields: { totalMinor: { status: 'unavailable' } } },
      });
      expect(page.data[0]!.data).toEqual({ status: 'open' });
      expect(page.meta).toMatchObject({ exhausted: true });
      expect(
        await objects.Invoice.traverse.customer(invoiceId, {
          select: ['name'],
        }),
      ).toMatchObject({
        status: 'ok',
        id: customerId,
        data: { name: 'north' },
      });
      expect(
        await relate
          .as(finance)
          .objects.Customer.traverse.invoices(customerId, {
            select: ['totalMinor'],
          }),
      ).toMatchObject({ data: [{ data: { totalMinor: 12500 } }] });
    });

    it.each([ana, finance])(
      'does not reveal another portfolio through either direction for $id',
      async (principal) => {
        const south = await relate.host.adopt(Customer, 'south');
        const invoiceId = await adoptInvoice('south_inv', 'south');
        const objects = relate.as(principal).objects;

        expect(await objects.Customer.traverse.invoices(south)).toEqual(
          await objects.Customer.traverse.invoices('unknown'),
        );
        expect(await objects.Invoice.traverse.customer(invoiceId)).toEqual({
          status: 'not-found',
        });
        expect(await objects.Invoice.traverse.customer('unknown')).toEqual({
          status: 'not-found',
        });
      },
    );

    it('never adopts missing endpoints and never contacts providers for an unknown starting ID', async () => {
      const objects = relate.as(ana).objects;

      await objects.Customer.traverse.invoices('unknown');
      await objects.Invoice.traverse.customer('unknown');
      expect(fetchInvoice).not.toHaveBeenCalled();
      const id = await adoptInvoice('inv_1', 'not-adopted');

      expect(await objects.Invoice.traverse.customer(id)).toEqual({
        status: 'not-found',
      });
    });

    it('paginates with bound opaque cursors and rechecks access on each continuation', async () => {
      const north = await relate.host.adopt(Customer, 'north');
      const ids = await Promise.all(
        ['one', 'two', 'three'].map((id) => adoptInvoice(id)),
      );
      const objects = relate.as(ana).objects;
      const first = await objects.Customer.traverse.invoices(north, {
        limit: 1,
        select: ['status'],
      });

      expect(first.data).toHaveLength(1);
      expect(first.meta.exhausted).toBe(false);
      const cursor = first.meta.continuationCursor!;

      for (const id of ids) expect(cursor).not.toContain(id);

      const second = await objects.Customer.traverse.invoices(north, {
        limit: 1,
        select: ['status'],
        cursor,
      });
      const third = await objects.Customer.traverse.invoices(north, {
        limit: 1,
        select: ['status'],
        cursor: second.meta.continuationCursor!,
      });

      expect(
        new Set(
          [...first.data, ...second.data, ...third.data].map((r) => r.id),
        ),
      ).toEqual(new Set(ids));
      expect(third.meta).toMatchObject({ exhausted: true });
      await expect(
        objects.Customer.traverse.invoices(north, {
          limit: 2,
          select: ['status'],
          cursor,
        }),
      ).rejects.toMatchObject({ code: 'invalid-request' });
      await expect(
        relate.as(finance).objects.Customer.traverse.invoices(north, {
          limit: 1,
          select: ['status'],
          cursor,
        }),
      ).rejects.toMatchObject({ code: 'invalid-request' });
      await expect(
        objects.Customer.traverse.invoices('unknown', {
          limit: 1,
          select: ['status'],
          cursor,
        }),
      ).rejects.toMatchObject({ code: 'invalid-request' });
      await expect(
        objects.Customer.traverse.invoices(north, {
          limit: 1,
          select: ['status'],
          cursor: cursor + 'x',
        }),
      ).rejects.toMatchObject({ code: 'invalid-request' });
      portfolios.set('north', 'south');
      now += 30_001;
      expect(
        (
          await objects.Customer.traverse.invoices(north, {
            limit: 1,
            select: ['status'],
            cursor,
          })
        ).data,
      ).toEqual([]);
    });

    it('follows current retained links and excludes deleted or reassigned invoices', async () => {
      const north = await relate.host.adopt(Customer, 'north');
      const south = await relate.host.adopt(Customer, 'south');
      const id = await adoptInvoice('inv_1');

      records.get('inv_1')!.customer_id = 'south';
      expect(
        (
          await relate
            .as(ana)
            .objects.Customer.traverse.invoices(north, { refresh: true })
        ).data,
      ).toEqual([]);
      expect(
        await relate.as(ana).objects.Invoice.traverse.customer(id),
      ).toEqual({ status: 'not-found' });
      expect(
        await relate
          .as({ ...ana, claims: { portfolio: 'south' } })
          .objects.Invoice.traverse.customer(id),
      ).toMatchObject({ status: 'ok', id: south });
      records.delete('inv_1');
      expect(
        (
          await relate
            .as({ ...ana, claims: { portfolio: 'south' } })
            .objects.Customer.traverse.invoices(south, { refresh: true })
        ).data,
      ).toEqual([]);
    });

    it('cannot grant traversal from expired or denied reference evidence', async () => {
      const north = await relate.host.adopt(Customer, 'north');
      const id = await adoptInvoice('inv_1');

      now += 10_001;
      unavailable.add('inv_1');
      expect(
        await relate.as(ana).objects.Invoice.traverse.customer(id, {
          select: ['id'],
          maxAgeMs: 100_000,
        }),
      ).toEqual({ status: 'not-found' });
      expect(
        (await relate.as(ana).objects.Customer.traverse.invoices(north)).data,
      ).toEqual([]);
      unavailable.clear();
      denied.add('inv_1');
      expect(
        await relate
          .as(ana)
          .objects.Invoice.traverse.customer(id, { refresh: true }),
      ).toEqual({ status: 'not-found' });
    });

    it('expires cursors and bounds page sizes', async () => {
      const north = await relate.host.adopt(Customer, 'north');

      await adoptInvoice('inv_1');
      await adoptInvoice('inv_2');
      const objects = relate.as(ana).objects;

      for (const limit of [0, -1, 1.5, 101, NaN])
        await expect(
          objects.Customer.traverse.invoices(north, { limit }),
        ).rejects.toMatchObject({ code: 'invalid-request' });

      const page = await objects.Customer.traverse.invoices(north, {
        limit: 1,
      });

      now += 900_001;
      await expect(
        objects.Customer.traverse.invoices(north, {
          limit: 1,
          cursor: page.meta.continuationCursor!,
        }),
      ).rejects.toMatchObject({ code: 'invalid-request' });
      await relate.close();
      await expect(objects.Customer.traverse.invoices(north)).rejects.toThrow(
        'closed',
      );
    });

    it('does not confuse customers within the same readable portfolio', async () => {
      const north = await relate.host.adopt(Customer, 'north');
      const harbour = await relate.host.adopt(Customer, 'harbour');
      const northInvoice = await adoptInvoice('inv_north');
      const harbourInvoice = await adoptInvoice('inv_harbour', 'harbour');
      const page = await relate
        .as(ana)
        .objects.Customer.traverse.invoices(north);

      expect(page.data.map((r) => r.id)).toEqual([northInvoice]);
      expect(JSON.stringify(page)).not.toContain(harbourInvoice);
      expect(
        await relate.as(ana).objects.Invoice.traverse.customer(harbourInvoice),
      ).toMatchObject({ status: 'ok', id: harbour });
    });

    it('honors reference field restrictions even when the field is not selected', async () => {
      await relate.close();
      const RestrictedInvoice = defineObject({
        ...Invoice,
        properties: {
          ...Invoice.properties,
          customer: reference(Customer, {
            id: 'invoice.customer',
            access: access.groups.financial,
            from: invoices.fields.customer_id,
          }),
        },
      });
      const CustomerInvoices = defineRelationship({
        ...graph.relationships.CustomerInvoices,
        to: RestrictedInvoice,
        via: RestrictedInvoice.properties.customer,
      });

      relate = start({
        ...graph,
        objects: { Customer, Invoice: RestrictedInvoice },
        relationships: { CustomerInvoices },
      });
      const north = await relate.host.adopt(Customer, 'north');

      records.set('inv_1', {
        customer_id: 'north',
        status: 'open',
        total_minor: 12500,
      });
      const id = await relate.host.adopt(RestrictedInvoice, 'inv_1');

      expect(
        await relate
          .as(ana)
          .objects.Invoice.traverse.customer(id, { select: ['id'] }),
      ).toEqual({ status: 'not-found' });
      expect(
        (
          await relate
            .as(ana)
            .objects.Customer.traverse.invoices(north, { select: ['id'] })
        ).data,
      ).toEqual([]);
      expect(
        (
          await relate.as(finance).objects.Customer.traverse.invoices(north)
        ).data.map((r) => r.id),
      ).toEqual([id]);
    });

    it('returns an opaque continuation for an empty non-final page without exposing hidden records', async () => {
      const north = await relate.host.adopt(Customer, 'north');

      await relate.host.adopt(Customer, 'south');
      const ids = await Promise.all(
        Array.from({ length: 101 }, (_, i) =>
          adoptInvoice(`hidden_${i}`, 'south'),
        ),
      );
      const first = await relate
        .as(ana)
        .objects.Customer.traverse.invoices(north);

      expect(first.data).toEqual([]);
      expect(first.meta.exhausted).toBe(false);

      for (const id of ids) expect(JSON.stringify(first)).not.toContain(id);

      const last = await relate
        .as(ana)
        .objects.Customer.traverse.invoices(north, {
          cursor: first.meta.continuationCursor!,
        });

      expect(last).toEqual({ data: [], meta: { exhausted: true } });
    });

    it('reports scan failures without provider or storage details', async () => {
      const north = await relate.host.adopt(Customer, 'north');

      vi.spyOn(backing.store, 'scan').mockRejectedValueOnce(
        new Error('private storage location'),
      );
      await expect(
        relate.as(ana).objects.Customer.traverse.invoices(north),
      ).rejects.toMatchObject({ code: 'unavailable', message: 'unavailable' });
    });
    it('iterates to-many traversal lazily across pages and retains selected field evidence', async () => {
      const north = await relate.host.adopt(Customer, 'north');
      const ids = await Promise.all(
        ['one', 'two', 'three'].map((id) => adoptInvoice(id)),
      );
      const scan = vi.spyOn(backing.store, 'scan');
      const query = relate.as(ana).objects.Customer.traverse.invoices(north, {
        limit: 1,
        select: ['totalMinor'],
      });

      expect(scan).not.toHaveBeenCalled();
      const found: string[] = [];

      for await (const invoice of query) {
        found.push(invoice.id);
        expect(invoice.data).toEqual({});
        expect(invoice.meta.fields.totalMinor).toEqual({
          status: 'unavailable',
        });
      }

      expect(new Set(found)).toEqual(new Set(ids));
    });
    it('rejects a repeated scan boundary even when cursor tokens would be re-encrypted', async () => {
      const north = await relate.host.adopt(Customer, 'north');

      await adoptInvoice('one');
      await adoptInvoice('two');
      const scan = backing.store.scan.bind(backing.store);

      // Faulty adapter ignores the requested boundary and repeats the first row.
      vi.spyOn(backing.store, 'scan').mockImplementation((scope, options) =>
        scan(scope, { limit: options.limit }),
      );
      const traverse = relate.as(ana).objects.Customer.traverse.invoices;
      const query = traverse(north, { limit: 1 });
      const first = await query;

      expect(first.meta.exhausted).toBe(false);

      if (first.meta.exhausted) throw new Error('Expected continuation');

      await expect(
        Promise.resolve(
          traverse(north, {
            limit: 1,
            cursor: first.meta.continuationCursor,
          }),
        ),
      ).rejects.toMatchObject({ code: 'incomplete' });
      const iterator = query[Symbol.asyncIterator]();

      expect((await iterator.next()).done).toBe(false);
      await expect(iterator.next()).rejects.toMatchObject({
        code: 'incomplete',
      });
    });
    it('preserves refreshed values and failed-retention evidence while rechecking membership', async () => {
      const north = await relate.host.adopt(Customer, 'north');
      const id = await adoptInvoice('inv_1');

      records.get('inv_1')!.status = 'paid';
      vi.spyOn(backing.store, 'accept').mockRejectedValue(
        new RetentionError('failed'),
      );
      const page = await relate
        .as(ana)
        .objects.Customer.traverse.invoices(north, {
          select: ['status'],
          refresh: true,
        });

      expect(page.data).toHaveLength(1);
      expect(page.data[0]).toMatchObject({
        id,
        data: { status: 'paid' },
        meta: {
          fields: { status: { retention: 'failed', refresh: 'succeeded' } },
        },
      });
    });
    it('withholds a member whose authorization expires while later members are checked', async () => {
      const north = await relate.host.adopt(Customer, 'north');
      const ids = [await adoptInvoice('one'), await adoptInvoice('two')].sort();
      const load = backing.store.load;
      let secondLoads = 0;

      vi.spyOn(backing.store, 'load').mockImplementation(async (scope, id) => {
        if (id === ids[1] && ++secondLoads === 2) now += 10_001;

        return load(scope, id);
      });
      const page = await relate
        .as(ana)
        .objects.Customer.traverse.invoices(north, { select: ['id'] });

      expect(page.data.map((r) => r.id)).toEqual([ids[1]]);
    });
  });
}
