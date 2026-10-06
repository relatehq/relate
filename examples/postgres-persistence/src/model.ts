import { z } from 'zod';
import {
  defineAccess,
  equals,
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
  claims: { organization: z.string() },
});

export const customers = defineSource({
  id: 'crm.customers',
  idField: 'id',
  schema: z.object({
    id: z.string(),
    display_name: z.string(),
    organization: z.string(),
    revenue: z.number(),
  }),
});

export const Customer = defineObject({
  id: 'business.customer',
  name: 'Customer',
  membership: source(customers),
  properties: {
    id: objectId({
      id: 'business.customer.key',
      access: access.groups.ordinary,
    }),
    name: from(customers.fields.display_name, {
      id: 'business.customer.name',
      access: access.groups.ordinary,
    }),
    organization: from(customers.fields.organization, {
      id: 'business.customer.organization',
      access: access.groups.ordinary,
    }),
    revenue: from(customers.fields.revenue, {
      id: 'business.customer.revenue',
      access: access.groups.financial,
    }),
  },
});

export const customerGraph = defineGraph({
  id: 'business.graph',
  objects: [Customer],
  access,
  policies: [
    access.policy(Customer, {
      read: {
        gate: access.role('employee'),
        where: equals(
          Customer.properties.organization,
          access.claims.organization,
        ),
        evidenceMaxAgeMs: 30_000,
      },
      groups: { financial: access.role('finance') },
    }),
  ],
});

// Hosts supply authenticated context; request bodies cannot choose these claims.
export const employee = {
  id: 'ana',
  roles: ['employee'],
  claims: { organization: 'org_north' },
};

export const finance = {
  ...employee,
  id: 'fin',
  roles: ['employee', 'finance'],
};
