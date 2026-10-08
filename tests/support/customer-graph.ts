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

/** Fresh graph definitions for shared package/storage contract tests. No example dependencies. */
export function createCustomerGraph() {
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
      display_name: z.string(),
      portfolio: z.string(),
      revenue: z.number(),
    }),
  });

  const Customer = defineObject({
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
      revenue: from(customers.fields.revenue, {
        id: 'business.customer.revenue',
        access: access.groups.financial,
      }),
    },
  });

  const customerGraph = defineGraph({
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
        groups: { financial: access.role('finance') },
      },
    },
  });

  // Hosts supply authenticated context; request bodies cannot choose these claims.
  const employee = {
    id: 'ana',
    roles: ['employee'],
    claims: { portfolio: 'portfolio_north' },
  };

  const finance = {
    ...employee,
    id: 'fin',
    roles: ['employee', 'finance'],
  };

  return { access, customers, Customer, customerGraph, employee, finance };
}
