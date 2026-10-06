import type { z } from 'zod';
import type { billingInvoices, crmCustomers } from '../source/model.js';

// Three different identifiers on purpose: CRM's, billing's, and Relate's own.
export const customers: Record<string, z.input<typeof crmCustomers.schema>> = {
  crm_456: {
    id: 'crm_456',
    display_name: 'Northwind Studio',
    portfolio: 'portfolio_north',
    status: 'active',
    revenue: 2_000_000,
  },
  // Adopt only for the same-portfolio write-integrity cases.
  crm_654: {
    id: 'crm_654',
    display_name: 'Harbour Design',
    portfolio: 'portfolio_north',
    status: 'active',
    revenue: 500_000,
  },
  crm_789: {
    id: 'crm_789',
    display_name: 'Southbank Supply',
    portfolio: 'portfolio_south',
    status: 'active',
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
  inv_north_other: {
    id: 'inv_north_other',
    crm_customer_id: 'crm_654',
    total_minor: 80_000,
    currency: 'EUR',
    status: 'open',
  },
  inv_south: {
    id: 'inv_south',
    crm_customer_id: 'crm_789',
    total_minor: 120_000,
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
