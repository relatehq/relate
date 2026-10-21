import { z } from 'zod';
import {
  computed,
  defineAccess,
  defineDataset,
  defineGraph,
  defineObject,
  native,
  nativeMembership,
  objectId,
} from 'relate';

/** Test-owned analytical declarations; no resource connection or example dependencies. */
export function createAnalyticalGraph(
  sql = 'SELECT COUNT(*) FROM self.events',
) {
  const access = defineAccess({
    roles: ['reader', 'analyst', 'private'],
    fieldGroups: ['ordinary', 'private'],
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
      amount: {
        id: 'events.amount',
        schema: z.int64(),
        access: access.groups.ordinary,
      },
      secret: {
        id: 'events.secret',
        schema: z.string(),
        access: access.groups.private,
      },
    },
  });
  const Customer = defineObject({
    id: 'customer',
    membership: nativeMembership(),
    properties: {
      id: objectId({ id: 'customer.id' }),
      externalId: native(z.string(), {
        id: 'customer.external',
        access: access.groups.private,
      }),
      label: native(z.string(), {
        id: 'customer.label',
        access: access.groups.private,
      }),
      count: computed({
        id: 'customer.count',
        sql,
        access: access.groups.private,
      }),
    },
    datasets: {
      events: {
        id: 'customer.events',
        dataset: Events,
        on: [{ column: 'customerId', property: 'externalId' }],
      },
    },
  });
  const graph = defineGraph({
    id: 'graph',
    access,
    objects: { Customer },
    datasets: { Events },
    policies: {
      Customer: {
        read: { gate: access.role('reader') },
        groups: { private: access.role('private') },
        datasets: { events: { gate: access.role('analyst') } },
      },
      Events: { groups: { private: access.role('private') } },
    },
  });

  return { graph, Customer, Events };
}
