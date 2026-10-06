import { z } from 'zod';
import {
  defineObject,
  defineRelationship,
  defineSource,
  from,
  native,
  nativeMembership,
  objectId,
  reference,
  source,
} from '../validation/target.js';
import { access } from './access.js';

const { ordinary, financial } = access.groups;

// An HTTP API owns customers.
export const crmCustomers = defineSource({
  id: 'crm.customers',
  idField: 'id',
  schema: z.object({
    id: z.string(),
    display_name: z.string(),
    portfolio: z.string(),
    status: z.enum(['active', 'inactive']),
    revenue: z.number(),
  }),
});

// A separate Postgres database owns invoices. It knows customers by CRM ID.
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
    // TODO(interim): this only works because billing happens to store the
    // CRM's ID. Real sources carry their own keys (`account_87`), which the
    // design resolves through aliases and exact-match enrichment. Replace
    // this with that path once sources can be resolved against each other.
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
    note: native(z.string(), {
      id: 'business.account-review.note',
      access: ordinary,
    }),
  },
});

// A follow-up owned by Relate, pointing at records of every kind.
export const Task = defineObject({
  id: 'business.task',
  label: 'Task',
  membership: nativeMembership(),
  properties: {
    id: objectId({ id: 'business.task.key', access: ordinary }),
    customer: reference(Customer, {
      id: 'business.task.customer',
      access: ordinary,
    }),
    review: reference(AccountReview, {
      id: 'business.task.review',
      access: ordinary,
    }),
    invoice: reference(Invoice, {
      id: 'business.task.invoice',
      access: ordinary,
    }),
    assignee: native(z.string(), {
      id: 'business.task.assignee',
      access: ordinary,
    }),
    dueDate: native(z.string(), {
      id: 'business.task.due-date',
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

export const ReviewTasks = defineRelationship({
  id: 'business.review-tasks',
  forward: 'tasks',
  reverse: 'review',
  via: Task.properties.review,
});

/** Shared object names for graph assembly and server-context inference. */
export const objects = { Customer, Invoice, AccountReview, Task };

/** Shared relationships for graph assembly and action traversal inference. */
export const relationships = { CustomerInvoices, CustomerReviews, ReviewTasks };
