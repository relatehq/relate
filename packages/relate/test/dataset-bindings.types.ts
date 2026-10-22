import { z } from 'zod';
import { bind, defineAccess, defineDataset, defineSource } from 'relate';
import type {
  AnalyticalResource,
  SourceResource,
  ApplicationSourceConnector,
} from 'relate/connectors';

const access = defineAccess({
  roles: [],
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
  },
});
const customers = defineSource({
  id: 'customers',
  idField: 'id',
  schema: z.object({ id: z.string() }),
});

export function bindings(
  resource: AnalyticalResource,
  keyed: SourceResource<ApplicationSourceConnector>,
) {
  bind(Events, resource);
  // @ts-expect-error A present physical column mapping must be a string.
  bind(Events, resource, { columns: { customerId: undefined } });
  bind(Events, resource, { columns: { customerId: 'customer_id' } });
  // @ts-expect-error mapping names belong to the declared dataset, with no inference widening
  bind(Events, resource, { columns: { customer_id: 'customerId' } });
  // @ts-expect-error physical names must be strings
  bind(Events, resource, { columns: { customerId: 1 } });
  // @ts-expect-error datasets require analytical capability
  bind(Events, keyed);
  // @ts-expect-error sources require keyed capability
  bind(customers, resource);
  // @ts-expect-error dataset binding has no source authorization option
  bind(Events, resource, { authorization: 'shared-service' });
}
