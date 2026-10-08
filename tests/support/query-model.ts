import { z } from 'zod';
import {
  defineAccess,
  defineSource,
  defineObject,
  defineGraph,
  defineAction,
  source,
  from,
  objectId,
  reference,
  native,
  nativeMembership,
} from 'relate';

export function createQueryModel() {
  const access = defineAccess({
    roles: ['employee', 'finance'],
    fieldGroups: ['ordinary', 'financial'],
    claims: { portfolio: z.string() },
  });
  const customers = defineSource({
    id: 'customers',
    idField: 'id',
    schema: z.object({ id: z.string(), portfolio: z.string() }),
  });
  const invoices = defineSource({
    id: 'invoices',
    idField: 'id',
    schema: z.object({
      id: z.string(),
      customer: z.string(),
      status: z.string().optional(),
      total: z.number().nullable(),
      paid: z.boolean(),
    }),
  });
  const Customer = defineObject({
    id: 'customer',
    membership: source(customers),
    properties: {
      id: objectId({ id: 'customer.id' }),
      portfolio: from(customers.fields.portfolio, { id: 'customer.portfolio' }),
    },
  });
  const Invoice = defineObject({
    id: 'invoice',
    membership: source(invoices),
    properties: {
      id: objectId({ id: 'invoice.id' }),
      customer: reference(Customer, {
        id: 'invoice.customer',
        from: invoices.fields.customer,
      }),
      status: from(invoices.fields.status, { id: 'invoice.status' }),
      total: from(invoices.fields.total, {
        id: 'invoice.total',
        access: access.groups.financial,
      }),
      paid: from(invoices.fields.paid, { id: 'invoice.paid' }),
    },
  });
  const Review = defineObject({
    id: 'review',
    membership: nativeMembership(),
    properties: {
      id: objectId({ id: 'review.id' }),
      note: native(z.string(), { id: 'review.note' }),
    },
  });
  const Run = defineAction({
    id: 'run',
    input: z.object({}),
    output: z.object({ count: z.number() }),
    creates: [Review],
    policy: { execute: access.role('employee') },
  });
  const graph = defineGraph({
    id: 'query-graph',
    objects: { Customer, Invoice, Review },
    actions: { run: Run },
    access,
    policies: {
      Customer: {
        read: {
          gate: access.role('employee'),
          where: { portfolio: { eq: access.claims.portfolio } },
          evidenceMaxAgeMs: 30_000,
        },
      },
      Invoice: {
        read: { gate: access.role('employee') },
        groups: { financial: access.role('finance') },
      },
      Review: {
        read: { gate: access.role('employee') },
        create: { gate: access.role('employee') },
      },
    },
  });

  return { graph, Run, Customer, Invoice, Review, customers, invoices };
}
