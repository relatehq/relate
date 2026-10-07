import { createMemoryStore } from '@relate/runtime';
import { invoiceReadContract } from '../../../tests/support/invoice-read-contract.js';

invoiceReadContract('Memory invoice reads', async () => ({
  store: createMemoryStore(),
  close: async () => {},
}));

import { expect, it } from 'vitest';
import { z } from 'zod';
import {
  defineObject,
  defineSource,
  reference,
  objectId,
  source,
} from 'relate';
import { connect, createRuntime } from '@relate/node';
import {
  access,
  ana,
  Customer,
  customers,
  graph,
  Invoice,
  invoices,
} from '../../../dev/fixtures/customer-graph/invoice-read/model.js';

it('enforces multiple predicates across two reference hops without exposing evidence fields', async () => {
  const credits = defineSource({
    id: 'credits',
    idField: 'id',
    schema: z.object({ id: z.string(), invoice_id: z.string() }),
  });
  const Credit = defineObject({
    id: 'credit',
    label: 'Credit',
    membership: source(credits),
    properties: {
      id: objectId({ id: 'credit.id', access: access.groups.ordinary }),
      invoice: reference(Invoice, {
        id: 'credit.invoice',
        access: access.groups.ordinary,
        from: credits.fields.invoice_id,
      }),
    },
  });
  const relate = createRuntime({
    graph: {
      ...graph,
      objects: { ...graph.objects, Credit },
      policies: {
        ...graph.policies,
        Credit: {
          read: {
            gate: access.role('employee'),
            where: {
              invoice: {
                customer: { portfolio: { eq: access.claims.portfolio } },
                status: { eq: access.claims.portfolio },
              },
            },
            evidenceMaxAgeMs: 1000,
          },
        },
      },
    },
    connections: [
      connect(customers, {
        providerAccountId: 'example-account',
        connectionId: 'crm',
        connector: {
          identify: async () => 'example-account',
          fetch: async (id) => ({
            providerAccountId: 'example-account',
            state: 'present',
            record: { id, name: 'Name', portfolio: 'north', revenue: 1 },
          }),
        },
      }),
      connect(invoices, {
        providerAccountId: 'example-account',
        connectionId: 'billing',
        connector: {
          identify: async () => 'example-account',
          fetch: async (id) => ({
            providerAccountId: 'example-account',
            state: 'present',
            record: {
              id,
              customer_id: 'crm_1',
              status: 'north',
              total_minor: 1,
            },
          }),
        },
      }),
      connect(credits, {
        providerAccountId: 'example-account',
        connectionId: 'credits',
        connector: {
          identify: async () => 'example-account',
          fetch: async (id) => ({
            providerAccountId: 'example-account',
            state: 'present',
            record: { id, invoice_id: 'inv_1' },
          }),
        },
      }),
    ],
  });

  try {
    await relate.host.adopt(Customer, 'crm_1');
    await relate.host.adopt(Invoice, 'inv_1');
    const id = await relate.host.adopt(Credit, 'credit_1');

    expect(
      await relate.as(ana).objects.Credit.get(id, { select: ['id'] }),
    ).toMatchObject({ status: 'ok', data: { id } });
    expect(
      await relate
        .as({ ...ana, claims: { portfolio: 'south' } })
        .objects.Credit.get(id),
    ).toEqual({ status: 'not-found' });
  } finally {
    await relate.close();
  }
});
