import { z } from 'zod';
import {
  defineAccess,
  defineAction,
  defineGraph,
  defineObject,
  defineSource,
  from,
  implementAction,
  native,
  nativeMembership,
  objectId,
  reference,
  referenceInput,
  source,
} from 'relate';

export const access = defineAccess({
  roles: ['employee', 'account-manager', 'finance'],
  fieldGroups: ['ordinary'],
  claims: { portfolio: z.string() },
});

export const customers = defineSource({
  id: 'crm.customers',
  idField: 'id',
  schema: z.object({ id: z.string(), name: z.string(), portfolio: z.string() }),
});

export const invoices = defineSource({
  id: 'billing.invoices',
  idField: 'id',
  schema: z.object({ id: z.string() }),
});

export const Customer = defineObject({
  id: 'business.customer',
  description: 'Organizations whose accounts are managed by the team.',
  membership: source(customers),
  properties: {
    id: objectId({
      id: 'customer.id',
      description: 'Opaque Relate customer ID.',
    }),
    name: from(customers.fields.name, {
      id: 'customer.name',
      description: 'Registered business name.',
    }),
    portfolio: from(customers.fields.portfolio, { id: 'customer.portfolio' }),
  },
});

export const Invoice = defineObject({
  id: 'business.invoice',
  membership: source(invoices),
  properties: { id: objectId({ id: 'invoice.id' }) },
});

export const AccountReview = defineObject({
  id: 'business.account-review',
  description: 'An account assessment written by a portfolio manager.',
  membership: nativeMembership(),
  properties: {
    id: objectId({ id: 'review.id' }),
    customer: reference(Customer, { id: 'review.customer' }),
    author: native(z.string(), { id: 'review.author' }),
    note: native(z.string().min(1).max(4000), { id: 'review.note' }),
  },
});

export const AddAccountReview = defineAction({
  id: 'business.add-account-review',
  description: 'Record a new assessment of a customer account.',
  input: z.object({
    customer: referenceInput(Customer, {
      description: 'Customer being reviewed.',
    }),
    note: z
      .string()
      .min(1)
      .max(4000)
      .describe('Assessment and recommended next steps.'),
  }),
  output: z.object({
    reviewId: referenceInput(AccountReview, {
      description: 'New account review ID.',
    }),
  }),
  creates: [AccountReview],
  policy: { execute: access.role('account-manager') },
});

export const graph = defineGraph({
  id: 'native-action',
  description: 'Customer accounts, invoices, and account reviews.',
  objects: { Customer, Invoice, AccountReview },
  actions: { addAccountReview: AddAccountReview },
  access,
  policies: {
    Customer: {
      read: {
        gate: access.role('employee'),
        where: { portfolio: { eq: access.claims.portfolio } },
        evidenceMaxAgeMs: 30_000,
      },
    },
    Invoice: { read: { gate: access.role('employee') } },
    AccountReview: {
      read: {
        gate: access.role('employee'),
        where: { customer: { portfolio: { eq: access.claims.portfolio } } },
        evidenceMaxAgeMs: 30_000,
      },
      create: {
        gate: access.role('account-manager'),
        where: {
          customer: { portfolio: { eq: access.claims.portfolio } },
          author: { eq: access.actor.id },
        },
        evidenceMaxAgeMs: 30_000,
      },
    },
  },
});

export const addAccountReview = implementAction(
  graph,
  AddAccountReview,
  async ({ actor, input, objects }) => {
    const customer = await objects.Customer.get(input.customer, {
      select: ['id'],
    });

    if (customer.status !== 'ok') throw new Error('Customer unavailable');

    const review = await objects.AccountReview.create({
      customer: customer.id,
      author: actor.id,
      note: input.note,
    });

    return { reviewId: review.id };
  },
);

export const ana = {
  id: 'ana',
  roles: ['employee', 'account-manager'],
  claims: { portfolio: 'north' },
};
