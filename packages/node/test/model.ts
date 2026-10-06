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
  label: 'Client account',
  pluralLabel: 'Client accounts',
  description: 'Customers visible to their assigned portfolio team.',
  membership: source(customers),
  properties: {
    id: objectId({ id: 'customer.id', access: access.groups.ordinary }),
    name: from(customers.fields.name, {
      id: 'customer.name',
      access: access.groups.ordinary,
    }),
    portfolio: from(customers.fields.portfolio, {
      id: 'customer.portfolio',
      access: access.groups.ordinary,
    }),
    revenue: from(customers.fields.revenue, {
      id: 'customer.revenue',
      access: access.groups.financial,
    }),
  },
});

export const graph = defineGraph({
  id: 'customer-read',
  objects: { Customer },
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
  },
});

export const ana = {
  id: 'ana',
  roles: ['employee'],
  claims: { portfolio: 'north' },
};

export const finance = { ...ana, id: 'fin', roles: ['employee', 'finance'] };
