import { z } from 'zod';
import {
  defineAccess,
  defineGraph,
  defineObject,
  defineRelationship,
  defineSource,
  from,
  objectId,
  reference,
  source,
} from 'relate';

export const access = defineAccess({
  roles: ['employee', 'finance'],
  fieldGroups: ['ordinary', 'financial'],
  claims: { portfolio: z.string() },
});

export const customers = defineSource({
  id: 'crm.customers',
  idField: 'id',
  schema: z.object({
    id: z.string(),
    name: z.string(),
    portfolio: z.string(),
    revenue: z.number(),
  }),
});

export const Customer = defineObject({
  id: 'business.customer',
  name: 'Customer',
  membership: source(customers),
  properties: {
    id: objectId({ id: 'customer.id' }),
    name: from(customers.fields.name, {
      id: 'customer.name',
    }),
    portfolio: from(customers.fields.portfolio, {
      id: 'customer.portfolio',
    }),
    revenue: from(customers.fields.revenue, {
      id: 'customer.revenue',
      access: access.groups.financial,
    }),
  },
});

export const invoices = defineSource({
  id: 'billing.invoices',
  idField: 'id',
  schema: z.object({
    id: z.string(),
    customer_id: z.string(),
    status: z.string(),
    total_minor: z.number(),
  }),
});

export const Invoice = defineObject({
  id: 'business.invoice',
  name: 'Invoice',
  membership: source(invoices),
  properties: {
    id: objectId({ id: 'invoice.id' }),
    customer: reference(Customer, {
      id: 'invoice.customer',
      from: invoices.fields.customer_id,
    }),
    status: from(invoices.fields.status, {
      id: 'invoice.status',
    }),
    totalMinor: from(invoices.fields.total_minor, {
      id: 'invoice.total',
      access: access.groups.financial,
    }),
  },
});

export const CustomerInvoices = defineRelationship({
  id: 'business.customer-invoices',
  forward: 'invoices',
  reverse: 'customer',
  via: Invoice.properties.customer,
});

export const relationships = { CustomerInvoices };

export const objects = { Customer, Invoice };

export const graph = defineGraph({
  id: 'invoice-read',
  objects,
  relationships,
  access,
  policies: {
    Customer: {
      read: {
        gate: access.role('employee'),
        where: { portfolio: { eq: access.claims.portfolio } },
        evidenceMaxAgeMs: 30_000,
      },
      groups: { financial: access.role('finance') },
    },
    Invoice: {
      read: {
        gate: access.role('employee'),
        where: { customer: { portfolio: { eq: access.claims.portfolio } } },
        evidenceMaxAgeMs: 10_000,
      },
      groups: { financial: access.role('finance') },
    },
  },
});

export const ana = {
  id: 'ana',
  roles: ['employee'],
  claims: { portfolio: 'north' },
};

export const finance = { ...ana, id: 'fin', roles: ['employee', 'finance'] };
