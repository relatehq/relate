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

/**
 * Fresh Customer/Invoice graph definitions for package, storage and app tests.
 * Test-owned: no dependency on `examples/` or `dev/fixtures`.
 */
export function createInvoiceGraph() {
  const access = defineAccess({
    roles: ['employee', 'finance'],
    fieldGroups: ['ordinary', 'financial'],
    claims: { portfolio: z.string() },
  });

  const customers = defineSource({
    id: 'crm.customers',
    idField: 'id',
    schema: z.object({
      id: z.string(),
      name: z.string(),
      portfolio: z.string(),
      revenue: z.number(),
    }),
  });

  const Customer = defineObject({
    id: 'business.customer',
    label: 'Customer',
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

  const invoices = defineSource({
    id: 'billing.invoices',
    idField: 'id',
    schema: z.object({
      id: z.string(),
      customer_id: z.string(),
      status: z.string(),
      total_minor: z.number(),
    }),
  });

  const Invoice = defineObject({
    id: 'business.invoice',
    label: 'Invoice',
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

  const CustomerInvoices = defineRelationship({
    id: 'business.customer-invoices',
    forward: 'invoices',
    reverse: 'customer',
    via: Invoice.properties.customer,
  });

  const graph = defineGraph({
    id: 'invoice-read',
    objects: { Customer, Invoice },
    relationships: { CustomerInvoices },
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

  const ana = {
    id: 'ana',
    roles: ['employee'],
    claims: { portfolio: 'north' },
  };

  const finance = { ...ana, id: 'fin', roles: ['employee', 'finance'] };

  return {
    access,
    customers,
    Customer,
    invoices,
    Invoice,
    CustomerInvoices,
    graph,
    ana,
    finance,
  };
}
