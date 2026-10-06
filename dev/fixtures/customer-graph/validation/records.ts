import type { z } from 'zod';
import type { billingInvoices, crmCustomers } from '../source/model.js';

// Three different identifiers on purpose: CRM's, billing's, and Relate's own.
export const customers: Record<string, z.input<typeof crmCustomers.schema>> = {
  crm_456: {
    id: 'crm_456',
    display_name: 'Northwind Studio',
    organization: 'org_north',
    revenue: 2_000_000,
  },
  crm_789: {
    id: 'crm_789',
    display_name: 'Southbank Supply',
    organization: 'org_south',
    revenue: 750_000,
  },
};

export const invoices: Record<
  string,
  z.input<typeof billingInvoices.schema>
> = {
  inv_1: {
    id: 'inv_1',
    crm_customer_id: 'crm_456',
    total_minor: 250_000,
    currency: 'EUR',
    status: 'open',
  },
  inv_2: {
    id: 'inv_2',
    crm_customer_id: 'crm_456',
    total_minor: 90_000,
    currency: 'EUR',
    status: 'paid',
  },
};
