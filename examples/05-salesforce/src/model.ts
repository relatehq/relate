import { z } from 'zod';
import {
  connect,
  defineAccess,
  defineApp,
  defineGraph,
  defineObject,
  defineSource,
  from,
  objectId,
  source,
} from 'relate';
import type { SourceConnector } from 'relate/connectors';

/** Application-owned Customer model, Salesforce mapping, and access policy. */
export function customerApp(
  connector: SourceConnector,
  providerAccountId: string,
) {
  const accounts = defineSource({
    id: 'salesforce.accounts',
    idField: 'Id',
    schema: z.object({
      Id: z.string(),
      IsDeleted: z.boolean(),
      Name: z.string(),
      Website: z.string().nullable(),
    }),
  });
  const Customer = defineObject({
    id: 'customer',
    label: 'Customer',
    membership: source(accounts),
    properties: {
      id: objectId({ id: 'customer.id' }),
      name: from(accounts.fields.Name, { id: 'customer.name' }),
      website: from(accounts.fields.Website, { id: 'customer.website' }),
    },
  });
  const access = defineAccess({
    roles: ['employee'],
    fieldGroups: ['ordinary'],
    claims: {},
  });
  const graph = defineGraph({
    id: 'salesforce-customers',
    objects: { Customer },
    access,
    policies: { Customer: { read: { gate: access.role('employee') } } },
  });
  const app = defineApp({
    graph,
    setup: () => ({
      connections: [
        connect(accounts, {
          connectionId: 'salesforce',
          providerAccountId,
          connector,
        }),
      ],
    }),
  });

  return {
    app,
    Customer,
    employee: { id: 'example-employee', roles: ['employee'], claims: {} },
  };
}
