import { z } from 'zod';
import {
  defineAccess,
  defineGraph,
  defineObject,
  defineSource,
  from,
  objectId,
  source,
} from 'relate';

export const access = defineAccess({
  roles: ['employee'],
  fieldGroups: ['ordinary'],
  claims: { portfolio: z.string() },
});

export const customers = defineSource({
  id: 'crm.customers',
  idField: 'id',
  schema: z.object({
    id: z.string(),
    display_name: z.string(),
    portfolio: z.string(),
    stripe_customer_id: z.string().nullable(),
  }),
});

export const Customer = defineObject({
  id: 'business.customer',
  label: 'Customer',
  membership: source(customers),
  properties: {
    id: objectId({
      id: 'business.customer.key',
    }),
    name: from(customers.fields.display_name, {
      id: 'business.customer.name',
    }),
    portfolio: from(customers.fields.portfolio, {
      id: 'business.customer.portfolio',
    }),
    stripeCustomerId: from(customers.fields.stripe_customer_id, {
      id: 'business.customer.stripeCustomerId',
    }),
  },
});

export const customerGraph = defineGraph({
  id: 'business.graph',
  objects: { Customer },
  access,
  policies: {
    Customer: {
      read: {
        gate: access.role('employee'),
        where: { portfolio: { eq: access.claims.portfolio } },
        evidenceMaxAgeMs: 30_000,
      },
    },
  },
});

// Hosts supply authenticated context; request bodies cannot choose these claims.
export const employee = {
  id: 'ana',
  roles: ['employee'],
  claims: { portfolio: 'portfolio_north' },
};
