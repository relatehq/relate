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

/** Physical row order: customerId, n, small, ratio, label, flag, at. */
export interface PropertyRow {
  readonly customerId: string;
  readonly n: bigint | null;
  readonly small: number | null;
  readonly ratio: number | null;
  readonly label: string | null;
  readonly flag: boolean | null;
  readonly at: string | null;
}

export type PropertyColumn = Exclude<keyof PropertyRow, 'customerId'>;

export const propertyColumnTypes = {
  n: 'int64',
  small: 'int32',
  ratio: 'float64',
  label: 'string',
  flag: 'boolean',
  at: 'timestamp',
} as const satisfies Record<PropertyColumn, string>;

/** Fixed objects; generated rows vary. `other` rows belong to no customer. */
export const propertyCustomers = [
  { id: 'c0', external: 'k0', since: '2026-10-01T00:00:00.123Z' },
  { id: 'c1', external: 'k1', since: '1970-01-01T00:00:00.000Z' },
  { id: 'c2', external: 'k2', since: '2026-10-02T00:00:00.000Z' },
  { id: 'c3', external: 'k3', since: '2026-10-01T00:00:00.124Z' },
] as const;

export const propertyCustomerKeys = [
  ...propertyCustomers.map((customer) => customer.external),
  'other',
];

export function createSqlPropertyGraph() {
  const access = defineAccess({
    roles: ['reader'],
    fieldGroups: ['ordinary'],
    claims: {},
  });
  const column = <T extends z.ZodType>(id: string, schema: T) => ({
    id,
    schema,
    access: access.groups.ordinary,
  });
  const Events = defineDataset({
    id: 'events',
    columns: {
      customerId: column('events.customer', z.string()),
      n: column('events.n', z.int64().nullable()),
      small: column('events.small', z.int32().nullable()),
      ratio: column('events.ratio', z.number().nullable()),
      label: column('events.label', z.string().nullable()),
      flag: column('events.flag', z.boolean().nullable()),
      at: column(
        'events.at',
        z.iso.datetime({ offset: true, precision: 6 }).nullable(),
      ),
    },
  });
  const Customer = defineObject({
    id: 'customer',
    membership: nativeMembership(),
    properties: {
      id: objectId({ id: 'customer.id' }),
      externalId: native(z.string(), { id: 'customer.external' }),
      since: native(z.iso.datetime({ offset: true, precision: 3 }), {
        id: 'customer.since',
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
    id: 'sql-properties',
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

  return { graph, Events };
}
