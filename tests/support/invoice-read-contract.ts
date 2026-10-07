import { randomUUID } from 'node:crypto';
import type { Policy } from 'relate';
import type { ObservationStore } from '@relate/runtime/storage';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { connect, createRuntime } from '@relate/node';
import { SourceAccessDenied } from '@relate/runtime';
import { RetentionError } from '@relate/runtime/storage';
import {
  access,
  ana,
  Customer,
  customers,
  finance,
  graph,
  Invoice,
  invoices,
} from '../../dev/fixtures/customer-graph/invoice-read/model.js';

export function invoiceReadContract(
  name: string,
  open: () => Promise<{ store: ObservationStore; close(): Promise<void> }>,
) {
  describe(name, () => {
    let backing: Awaited<ReturnType<typeof open>>;
    const runtimes: Array<{ close(): Promise<void> }> = [];

    beforeEach(async () => {
      backing = await open();
    });
    afterEach(async () => {
      await Promise.all(runtimes.splice(0).map((relate) => relate.close()));
      await backing?.close();
    });

    function fixture(
      model: Omit<typeof graph, 'policies'> & {
        policies: Readonly<Record<string, Policy>>;
      } = graph,
    ) {
      let now = 1_000;
      let customerKey = 'crm_456';
      let portfolio = 'north';
      let customerState = 'present';
      let invoiceState = 'present';
      let failRetention = false;
      const memory = backing.store;
      const store = {
        ...memory,
        accept: vi.fn(async (...args: Parameters<typeof memory.accept>) => {
          if (failRetention) throw new RetentionError('failed');

          return memory.accept(...args);
        }),
      };
      const fetchCustomer = vi.fn(async (id: string) => {
        if (customerState === 'offline') throw new Error('offline');

        if (customerState === 'forbidden') throw new SourceAccessDenied();

        if (customerState === 'deleted')
          return {
            providerAccountId: 'example-account',
            state: 'deleted' as const,
          };

        return {
          providerAccountId: 'example-account',
          state: 'present' as const,
          record: { id, name: 'Northwind', portfolio, revenue: 100 },
        };
      });
      const relate = createRuntime({
        graph: model,
        graphId: randomUUID(),
        store,
        clock: () => now,
        connections: [
          connect(customers, {
            providerAccountId: 'example-account',
            connectionId: 'crm',
            connector: {
              identify: async () => 'example-account',
              fetch: fetchCustomer,
            },
          }),
          connect(invoices, {
            providerAccountId: 'example-account',
            connectionId: 'billing',
            connector: {
              identify: async () => 'example-account',
              async fetch(id) {
                if (invoiceState === 'offline') throw new Error('offline');

                return {
                  providerAccountId: 'example-account',
                  state: 'present',
                  record: {
                    id,
                    customer_id: customerKey,
                    status: 'open',
                    total_minor: 12345,
                  },
                };
              },
            },
          }),
        ],
      });

      runtimes.push(relate);

      return {
        relate,
        store,
        fetchCustomer,
        advance(ms: number) {
          now += ms;
        },
        setCustomer(state: string) {
          customerState = state;
        },
        setInvoice(state: string) {
          invoiceState = state;
        },
        setKey(key: string) {
          customerKey = key;
        },
        setPortfolio(value: string) {
          portfolio = value;
        },
        failRetention() {
          failRetention = true;
        },
      };
    }

    it('resolves the source key to an adopted canonical ID and independently gates amounts', async () => {
      const { relate } = fixture();
      const customerId = await relate.host.adopt(Customer, 'crm_456');
      const invoiceId = await relate.host.adopt(Invoice, 'inv_1');
      const invoice = await relate.as(ana).objects.Invoice.get(invoiceId, {
        select: ['customer', 'status', 'totalMinor'],
      });

      expect(customerId).not.toBe('crm_456');
      expect(invoice).toMatchObject({
        status: 'ok',
        data: { customer: customerId, status: 'open' },
        meta: { fields: { totalMinor: { status: 'forbidden' } } },
      });

      if (invoice.status !== 'ok') throw new Error('Expected invoice');

      expect(invoice.data).toEqual({ customer: customerId, status: 'open' });
      expect(
        await relate.as(finance).objects.Invoice.get(invoiceId),
      ).toMatchObject({ data: { customer: customerId, totalMinor: 12345 } });
      await relate.close();
    });

    it('never adopts or fetches an unmapped target and resolves it after explicit adoption', async () => {
      const { relate, fetchCustomer, store } = fixture();
      const invoiceId = await relate.host.adopt(Invoice, 'inv_1');

      store.accept.mockClear();
      expect(await relate.as(ana).objects.Invoice.get(invoiceId)).toEqual({
        status: 'not-found',
      });
      expect(fetchCustomer).not.toHaveBeenCalled();
      expect(store.accept).not.toHaveBeenCalled();
      const customerId = await relate.host.adopt(Customer, 'crm_456');

      expect(await relate.as(ana).objects.Invoice.get(invoiceId)).toMatchObject(
        { data: { customer: customerId } },
      );
      await relate.close();
    });

    it.each([ana, finance])(
      'conceals invoices in another portfolio from $id',
      async (principal) => {
        const { relate } = fixture();

        await relate.host.adopt(Customer, 'crm_456');
        const id = await relate.host.adopt(Invoice, 'inv_1');

        expect(
          await relate
            .as({ ...principal, claims: { portfolio: 'south' } })
            .objects.Invoice.get(id),
        ).toEqual({ status: 'not-found' });
        expect(
          await relate.as({ ...principal, claims: {} }).objects.Invoice.get(id),
        ).toEqual({ status: 'not-found' });
        await relate.close();
      },
    );

    it.each(['customer', 'invoice'])(
      'denies expired %s evidence even when selecting only native identity',
      async (owner) => {
        const f = fixture();

        await f.relate.host.adopt(Customer, 'crm_456');
        const id = await f.relate.host.adopt(Invoice, 'inv_1');

        f.advance(10_001);

        if (owner === 'customer') f.setCustomer('offline');
        else f.setInvoice('offline');

        expect(
          await f.relate
            .as(finance)
            .objects.Invoice.get(id, { select: ['id'], maxAgeMs: 100_000 }),
        ).toEqual({ status: 'not-found' });
        await f.relate.close();
      },
    );

    it.each(['forbidden', 'deleted'])(
      'does not leak a referenced customer after provider %s',
      async (state) => {
        const f = fixture();

        await f.relate.host.adopt(Customer, 'crm_456');
        const id = await f.relate.host.adopt(Invoice, 'inv_1');

        f.setCustomer(state);
        expect(
          await f.relate.as(finance).objects.Invoice.get(id, { refresh: true }),
        ).toEqual({ status: 'not-found' });
        await f.relate.close();
      },
    );

    it('cannot establish nested permission from fresh evidence that failed retention', async () => {
      const f = fixture();

      await f.relate.host.adopt(Customer, 'crm_456');
      const id = await f.relate.host.adopt(Invoice, 'inv_1');

      f.advance(30_001);
      // Keep the invoice current so only the nested Customer refresh fails retention.
      await f.relate.host.adopt(Invoice, 'inv_1');
      f.failRetention();
      expect(await f.relate.as(finance).objects.Invoice.get(id)).toEqual({
        status: 'not-found',
      });
      await f.relate.close();
    });

    it('rechecks a changed reference before returning its ID', async () => {
      const f = fixture();

      await f.relate.host.adopt(Customer, 'crm_456');
      f.setPortfolio('south');
      await f.relate.host.adopt(Customer, 'crm_other');
      const id = await f.relate.host.adopt(Invoice, 'inv_1');

      f.setKey('crm_other');
      expect(
        await f.relate.as(finance).objects.Invoice.get(id, { refresh: true }),
      ).toEqual({ status: 'not-found' });
      await f.relate.close();
    });

    it('withholds an unresolved reference even when the owner has a role-only policy', async () => {
      const f = fixture({
        ...graph,
        policies: {
          Customer: graph.policies.Customer,
          Invoice: {
            read: { gate: access.role('employee') },
          },
        },
      });
      const id = await f.relate.host.adopt(Invoice, 'inv_1');

      expect(
        await f.relate
          .as(ana)
          .objects.Invoice.get(id, { select: ['customer', 'status'] }),
      ).toMatchObject({
        status: 'ok',
        data: { status: 'open' },
        meta: { fields: { customer: { status: 'unavailable' } } },
      });
      expect(f.fetchCustomer).not.toHaveBeenCalled();
      await f.relate.close();
    });

    it('evaluates explicit related attributes privately without delegating to the target policy', async () => {
      const f = fixture({
        ...graph,
        policies: {
          Customer: { read: 'deny' },
          Invoice: graph.policies.Invoice,
        },
      });
      const customerId = await f.relate.host.adopt(Customer, 'crm_456');
      const id = await f.relate.host.adopt(Invoice, 'inv_1');
      const result = await f.relate
        .as(ana)
        .objects.Invoice.get(id, { select: ['customer', 'status'] });

      expect(result).toMatchObject({
        status: 'ok',
        data: { status: 'open' },
        meta: { fields: { customer: { status: 'unavailable' } } },
      });
      expect(JSON.stringify(result)).not.toContain(customerId);
      await f.relate.close();
    });

    it.each(['customer', 'portfolio'])(
      'denies missing retained %s evidence without disclosing the target',
      async (missing) => {
        const f = fixture();
        const customerId = await f.relate.host.adopt(Customer, 'crm_456');
        const id = await f.relate.host.adopt(Invoice, 'inv_1');

        if (missing === 'customer') {
          const load = f.store.load;

          vi.spyOn(f.store, 'load').mockImplementation(async (...args) => {
            const stored = await load(...args);

            if (stored) delete stored.observation.values.customer;

            return stored;
          });
        } else {
          const resolve = f.store.resolve;

          vi.spyOn(f.store, 'resolve').mockImplementation(async (...args) => {
            const stored = await resolve(...args);

            if (stored) delete stored.observation.values.portfolio;

            return stored;
          });
        }

        const result = await f.relate.as(finance).objects.Invoice.get(id);

        expect(result).toEqual({ status: 'not-found' });
        expect(JSON.stringify(result)).not.toContain(customerId);
      },
    );

    it('does not interpret a foreign key as a canonical ID or expose lookup failures', async () => {
      const f = fixture();
      const customerId = await f.relate.host.adopt(Customer, 'crm_456');

      f.setKey(customerId);
      const id = await f.relate.host.adopt(Invoice, 'inv_1');

      f.fetchCustomer.mockClear();
      expect(await f.relate.as(finance).objects.Invoice.get(id)).toEqual({
        status: 'not-found',
      });
      expect(f.fetchCustomer).not.toHaveBeenCalled();
      vi.spyOn(f.store, 'resolve').mockRejectedValue(
        new Error('private connection information'),
      );
      expect(await f.relate.as(finance).objects.Invoice.get(id)).toEqual({
        status: 'not-found',
      });
    });

    it('does not refresh an invoice into newly granted permission when retention fails', async () => {
      const f = fixture();

      await f.relate.host.adopt(Customer, 'crm_456');
      const id = await f.relate.host.adopt(Invoice, 'inv_1');

      f.advance(10_001);
      await f.relate.host.adopt(Customer, 'crm_456');
      f.failRetention();
      expect(await f.relate.as(finance).objects.Invoice.get(id)).toEqual({
        status: 'not-found',
      });
    });
    it('cannot reuse looser cached permission after a stricter target check is denied', async () => {
      const customerPolicy = graph.policies.Customer!;
      const f = fixture({
        ...graph,
        policies: {
          Customer: {
            ...customerPolicy,
            read: { ...customerPolicy.read, evidenceMaxAgeMs: 500 },
          },
          Invoice: graph.policies.Invoice,
        },
      });

      await f.relate.host.adopt(Customer, 'crm_456');
      const id = await f.relate.host.adopt(Invoice, 'inv_1');

      f.advance(1_000);
      f.setCustomer('forbidden');
      // Invoice's 10s policy evidence is current, but target disclosure needs 500ms.
      expect(await f.relate.as(finance).objects.Invoice.get(id)).toEqual({
        status: 'not-found',
      });
    });
  });
}
