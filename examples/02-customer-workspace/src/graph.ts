import { z } from 'zod';
import {
  defineAccess,
  defineAction,
  defineGraph,
  referenceInput,
  defineObject,
  defineRelationship,
  defineSource,
  from,
  native,
  nativeMembership,
  objectId,
  reference,
  source,
} from 'relate';

export const access = defineAccess({
  roles: ['employee', 'account-manager', 'finance'],
  fieldGroups: ['ordinary', 'financial'],
  claims: { portfolio: z.string() },
});

const { ordinary, financial } = access.groups;

// An HTTP API owns customers.
export const crmCustomers = defineSource({
  id: 'crm.customers',
  idField: 'id',
  schema: z.object({
    id: z.string(),
    display_name: z.string(),
    portfolio: z.string(),
    status: z.string(),
    revenue: z.number(),
  }),
});

// A separate SQLite database owns invoices. It knows customers by CRM ID.
export const billingInvoices = defineSource({
  id: 'billing.invoices',
  idField: 'id',
  schema: z.object({
    id: z.string(),
    crm_customer_id: z.string(),
    total_minor: z.number(),
    currency: z.string(),
    status: z.string(),
  }),
});

export const Customer = defineObject({
  id: 'business.customer',
  label: 'Customer',
  membership: source(crmCustomers),
  properties: {
    id: objectId({ id: 'business.customer.key', access: ordinary }),
    name: from(crmCustomers.fields.display_name, {
      id: 'business.customer.name',
      access: ordinary,
    }),
    portfolio: from(crmCustomers.fields.portfolio, {
      id: 'business.customer.portfolio',
      access: ordinary,
    }),
    status: from(crmCustomers.fields.status, {
      id: 'business.customer.status',
      access: ordinary,
    }),
    revenue: from(crmCustomers.fields.revenue, {
      id: 'business.customer.revenue',
      access: financial,
    }),
  },
});

export const Invoice = defineObject({
  id: 'business.invoice',
  label: 'Invoice',
  membership: source(billingInvoices),
  properties: {
    id: objectId({ id: 'business.invoice.key', access: ordinary }),
    // Billing's `crm_456` becomes the Customer's own object ID.
    customer: reference(Customer, {
      id: 'business.invoice.customer',
      access: ordinary,
      from: billingInvoices.fields.crm_customer_id,
    }),
    status: from(billingInvoices.fields.status, {
      id: 'business.invoice.status',
      access: ordinary,
    }),
    totalMinor: from(billingInvoices.fields.total_minor, {
      id: 'business.invoice.total-minor',
      access: financial,
    }),
    currency: from(billingInvoices.fields.currency, {
      id: 'business.invoice.currency',
      access: financial,
    }),
  },
});

// Relate owns reviews; they exist only because an action created them.
export const AccountReview = defineObject({
  id: 'business.account-review',
  label: 'Account review',
  pluralLabel: 'Account reviews',
  description: 'An assessment of a customer account and its next steps.',
  membership: nativeMembership(),
  properties: {
    id: objectId({ id: 'business.account-review.key', access: ordinary }),
    customer: reference(Customer, {
      id: 'business.account-review.customer',
      access: ordinary,
    }),
    author: native(z.string(), {
      id: 'business.account-review.author',
      access: ordinary,
    }),
    note: native(z.string().min(1).max(4000), {
      id: 'business.account-review.note',
      access: ordinary,
    }),
  },
});

export const CustomerInvoices = defineRelationship({
  id: 'business.customer-invoices',
  forward: 'invoices',
  reverse: 'customer',
  via: Invoice.properties.customer,
});

export const CustomerReviews = defineRelationship({
  id: 'business.customer-reviews',
  forward: 'reviews',
  reverse: 'customer',
  via: AccountReview.properties.customer,
});

export const AddAccountReview = defineAction({
  id: 'business.add-account-review',
  input: z.object({
    customer: referenceInput(Customer),
    note: z.string().min(1).max(4000),
  }),
  output: z.object({ reviewId: referenceInput(AccountReview) }),
  creates: [AccountReview],
  policy: { execute: access.role('account-manager') },
});

export const graph = defineGraph({
  id: 'customer-workspace',
  objects: { Customer, Invoice, AccountReview },
  relationships: { CustomerInvoices, CustomerReviews },
  actions: { addAccountReview: AddAccountReview },
  access,
  policies: {
    Customer: {
      read: {
        gate: access.role('employee'),
        where: { portfolio: { eq: access.claims.portfolio } },
        evidenceMaxAgeMs: 30000,
      },
      groups: { financial: access.role('finance') },
    },
    Invoice: {
      read: {
        gate: access.role('employee'),
        where: { customer: { portfolio: { eq: access.claims.portfolio } } },
        evidenceMaxAgeMs: 30000,
      },
      groups: { financial: access.role('finance') },
    },
    AccountReview: {
      read: {
        gate: access.role('employee'),
        where: { customer: { portfolio: { eq: access.claims.portfolio } } },
        evidenceMaxAgeMs: 30000,
      },
      create: {
        gate: access.role('account-manager'),
        where: {
          customer: { portfolio: { eq: access.claims.portfolio } },
          author: { eq: access.actor.id },
        },
        evidenceMaxAgeMs: 30000,
      },
    },
  },
});
