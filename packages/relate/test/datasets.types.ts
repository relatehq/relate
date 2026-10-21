import { z } from 'zod';
import {
  defineAccess,
  defineDataset,
  defineGraph,
  defineObject,
  native,
  nativeMembership,
  objectId,
} from 'relate';
import type { DatasetRow, Policies } from 'relate';

const access = defineAccess({
  roles: ['reader'],
  fieldGroups: ['ordinary'],
  claims: {},
});
const Events = defineDataset({
  id: 'events',
  columns: {
    customerId: {
      id: 'events.customer',
      schema: z.string(),
      access: access.groups.ordinary,
    },
    count: {
      id: 'events.count',
      schema: z.int64(),
      access: access.groups.ordinary,
    },
    user: {
      id: 'events.user',
      schema: z.string().nullable(),
      access: access.groups.ordinary,
    },
  },
});

export const row: DatasetRow<typeof Events> = {
  customerId: 'crm',
  count: 9007199254740993n,
  user: null,
};

export const wrongRow: DatasetRow<typeof Events> = {
  customerId: 'crm',
  // @ts-expect-error the inferred row retains exact bigint input rather than number
  count: 1,
  user: null,
};

// @ts-expect-error nullable columns remain required in the row
export const absentColumn: DatasetRow<typeof Events> = {
  customerId: 'crm',
  count: 1n,
};

const separateSchema = {
  id: 'invalid',
  columns: Events.columns,
  schema: z.object({}),
};

// @ts-expect-error a separate schema is rejected even in an extracted variable
export const duplicateSchema = defineDataset(separateSchema);

const Customer = defineObject({
  id: 'customer',
  membership: nativeMembership(),
  properties: {
    id: objectId({ id: 'customer.id' }),
    externalId: native(z.string(), { id: 'customer.external' }),
  },
  datasets: {
    events: {
      id: 'customer.events',
      dataset: Events,
      on: [{ column: 'customerId', property: 'externalId' }],
    },
  },
});

export const graph = defineGraph({
  id: 'graph',
  access,
  objects: { Customer },
  datasets: { Events },
  policies: {
    Customer: {
      read: { gate: access.role('reader') },
      datasets: { events: { gate: access.role('reader') } },
    },
    Events: {},
  },
});

export const unknownColumn = defineObject({
  id: 'customer',
  membership: nativeMembership(),
  properties: Customer.properties,
  datasets: {
    events: {
      id: 'customer.events',
      dataset: Events,
      // @ts-expect-error the column name must belong to this dataset
      on: [{ column: 'unknown', property: 'externalId' }],
    },
  },
});

export const unknownProperty = defineObject({
  id: 'customer',
  membership: nativeMembership(),
  properties: Customer.properties,
  datasets: {
    events: {
      id: 'customer.events',
      dataset: Events,
      // @ts-expect-error the property name must belong to the containing object
      on: [{ column: 'customerId', property: 'unknown' }],
    },
  },
});

export const emptyPairs = defineObject({
  id: 'customer',
  membership: nativeMembership(),
  properties: Customer.properties,
  datasets: {
    events: {
      id: 'customer.events',
      dataset: Events,
      // @ts-expect-error correlation requires at least one pair
      on: [],
    },
  },
});

type Rules = Policies<
  { Customer: typeof Customer },
  typeof access,
  { Events: typeof Events }
>;

export const missingAssociation: Rules = {
  // @ts-expect-error an object with associations must declare their gates
  Customer: { read: { gate: access.role('reader') } },
  Events: {},
};

export const unknownAssociation: Rules = {
  Customer: {
    read: { gate: access.role('reader') },
    datasets: {
      events: { gate: access.role('reader') },
      // @ts-expect-error association policy keys are exact
      wrong: { gate: access.role('reader') },
    },
  },
  Events: {},
};

export const uncorrelatedRead: Rules = {
  Customer: graph.policies.Customer,
  // @ts-expect-error uncorrelated dataset row policies are not part of v1
  Events: { read: { gate: access.role('reader') } },
};
