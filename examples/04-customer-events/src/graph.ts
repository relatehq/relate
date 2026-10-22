import { z } from 'zod';
import {
  computed,
  defineAccess,
  defineDataset,
  defineGraph,
  defineObject,
  defineSource,
  from,
  objectId,
  source,
} from 'relate';

const access = defineAccess({
  roles: ['employee', 'account-manager', 'finance', 'support'],
  fieldGroups: ['ordinary', 'identifying'],
  claims: { portfolio: z.string() },
});
const { ordinary, identifying } = access.groups;
const timestamp = z.iso.datetime({ offset: true, precision: 3 });

export const crmCustomers = defineSource({
  id: 'crm.customers',
  idField: 'id',
  schema: z.object({
    id: z.string(),
    name: z.string(),
    portfolio: z.string(),
    customer_since: timestamp,
  }),
});

// Event rows have no Relate identity or membership. Duplicates remain meaningful.
export const Events = defineDataset({
  id: 'analytics.events',
  description: 'One row per recorded customer event.',
  columns: {
    customerId: {
      id: 'analytics.events.customer-id',
      schema: z.string(),
      access: ordinary,
    },
    eventType: {
      id: 'analytics.events.event-type',
      schema: z.string(),
      access: ordinary,
    },
    occurredAt: {
      id: 'analytics.events.occurred-at',
      schema: timestamp,
      access: ordinary,
    },
    userId: {
      id: 'analytics.events.user-id',
      description:
        'Identifier of the user who performed the event; null for anonymous events.',
      schema: z.string().nullable(),
      access: identifying,
    },
  },
});

const customer = {
  id: 'business.customer',
  label: 'Customer',
  pluralLabel: 'Customers',
  membership: source(crmCustomers),
  properties: {
    id: objectId({ id: 'business.customer.id' }),
    name: from(crmCustomers.fields.name, { id: 'business.customer.name' }),
    externalId: from(crmCustomers.fields.id, {
      id: 'business.customer.external-id',
    }),
    portfolio: from(crmCustomers.fields.portfolio, {
      id: 'business.customer.portfolio',
    }),
    customerSince: from(crmCustomers.fields.customer_since, {
      id: 'business.customer.since',
    }),
  },
  datasets: {
    events: {
      id: 'business.customer.events',
      dataset: Events,
      on: [{ column: 'customerId', property: 'externalId' }],
    },
  },
} as const;

// The main example has no declared login count: callers supply their own expressions.
export const Customer = defineObject(customer);

export const graph = defineGraph({
  id: 'customer-events',
  access,
  objects: { Customer },
  datasets: { Events },
  policies: {
    Customer: {
      read: {
        gate: access.role('employee'),
        evidenceMaxAgeMs: 60_000,
        where: { portfolio: { eq: access.claims.portfolio } },
      },
      datasets: { events: { gate: access.role('account-manager') } },
    },
    Events: { groups: { identifying: access.role('support') } },
  },
  principals: {
    ana: {
      roles: ['employee', 'account-manager'],
      claims: { portfolio: 'portfolio_north' },
    },
    fin: {
      roles: ['employee', 'finance'],
      claims: { portfolio: 'portfolio_north' },
    },
  },
});

// An optional extension: the same SQL path, with a reusable name and stable ID.
export const declaredGraph = defineGraph({
  ...graph,
  objects: {
    Customer: defineObject({
      ...customer,
      properties: {
        ...customer.properties,
        loginCount: computed({
          id: 'business.customer.login-count',
          access: ordinary,
          sql: "SELECT COUNT(*) FROM self.events e WHERE e.eventType = 'login'",
        }),
      },
    }),
  },
});

export const actors = {
  ana: { id: 'ana', ...graph.principals.ana },
  fin: { id: 'fin', ...graph.principals.fin },
};
