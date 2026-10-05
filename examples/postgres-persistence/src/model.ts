import { z } from 'zod';
import {
  defineGraph,
  defineObject,
  defineSource,
  from,
  objectId,
  source,
} from 'relate';

export const customers = defineSource({
  definitionId: 'crm.customers',
  idField: 'id',
  schema: z.object({
    id: z.string(),
    display_name: z.string(),
    organization: z.string(),
    revenue: z.number(),
  }),
});

export const Customer = defineObject({
  definitionId: 'business.customer',
  name: 'Customer',
  membership: source(customers),
  properties: {
    id: objectId({ definitionId: 'business.customer.key', access: 'ordinary' }),
    name: from(customers.fields.display_name, {
      definitionId: 'business.customer.name',
      access: 'ordinary',
    }),
    organization: from(customers.fields.organization, {
      definitionId: 'business.customer.organization',
      access: 'ordinary',
    }),
    revenue: from(customers.fields.revenue, {
      definitionId: 'business.customer.revenue',
      access: 'financial',
    }),
  },
});

export const customerGraph = defineGraph({
  definitionId: 'business.graph',
  objects: [Customer],
  fieldGroups: ['ordinary', 'financial'],
  policies: {
    [Customer.definitionId]: {
      read: {
        role: 'employee',
        where: {
          propertyDefinitionId: Customer.properties.organization.definitionId,
          claim: 'organization',
        },
        evidenceMaxAgeMs: 30_000,
      },
      groups: { financial: { role: 'finance' } },
    },
  },
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
