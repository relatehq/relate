import { expect, it } from 'vitest';
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
import { compile } from 'relate/compiler';
import { createSqlParser } from '@relate/sql-parser';
import { createDiscovery } from '@relate/runtime';

async function discovery(roles: string[]) {
  const access = defineAccess({
    roles: ['reader', 'analyst', 'private'],
    fieldGroups: ['ordinary', 'private'],
    claims: {},
  });
  const Events = defineDataset({
    id: 'events',
    description: 'Customer events.',
    columns: {
      customer: {
        id: 'event.customer',
        schema: z.string(),
        access: access.groups.ordinary,
      },
      amount: {
        id: 'event.amount',
        schema: z.int64(),
        access: access.groups.ordinary,
        description: 'Exact amount.',
      },
      secret: {
        id: 'event.secret',
        schema: z.string().nullable(),
        access: access.groups.private,
        description: 'Restricted event detail.',
      },
    },
  });
  const Customer = defineObject({
    id: 'customer',
    membership: nativeMembership(),
    properties: {
      id: objectId({ id: 'customer.id' }),
      key: native(z.string(), {
        id: 'customer.key',
        access: access.groups.private,
      }),
      count: computed({
        id: 'customer.count',
        sql: 'SELECT COUNT(*) FROM self.events',
        description: 'Event count.',
      }),
      secret: computed({
        id: 'customer.secret',
        sql: 'SELECT MIN(secret) FROM self.events',
        access: access.groups.private,
      }),
    },
    datasets: {
      events: {
        id: 'customer.events',
        dataset: Events,
        on: [{ column: 'customer', property: 'key' }],
      },
    },
  });
  const graph = defineGraph({
    id: 'analytical-discovery',
    objects: { Customer },
    datasets: { Events },
    access,
    policies: {
      Customer: {
        read: { gate: access.role('reader') },
        groups: { private: access.role('private') },
        datasets: { events: { gate: access.role('analyst') } },
      },
      Events: { groups: { private: access.role('private') } },
    },
  });

  return createDiscovery(
    compile(graph),
    { id: 'actor', roles, claims: {} },
    await createSqlParser(),
  );
}

it('describes authorized associations, exact logical types and computed properties without SQL', async () => {
  const view = await discovery(['reader', 'analyst', 'private']);
  const object = view.describeObject('customer')!;

  expect(object.datasets).toEqual({
    events: {
      definitionId: 'customer.events',
      datasetDefinitionId: 'events',
      description: 'Customer events.',
      columns: {
        customer: {
          definitionId: 'event.customer',
          type: 'string',
          nullable: false,
          readable: true,
        },
        amount: {
          definitionId: 'event.amount',
          type: 'int64',
          nullable: false,
          readable: true,
          description: 'Exact amount.',
        },
        secret: {
          definitionId: 'event.secret',
          type: 'string',
          nullable: true,
          readable: true,
          description: 'Restricted event detail.',
        },
      },
      correlation: '"customer" = self."key"',
    },
  });
  expect(object.properties).toContainEqual(
    expect.objectContaining({
      definitionId: 'customer.count',
      name: 'count',
      description: 'Event count.',
      kind: 'computed',
      readable: true,
      schema: { type: 'int64', nullable: false },
      filterOperators: [],
    }),
  );
  expect(object.properties).toContainEqual(
    expect.objectContaining({
      name: 'secret',
      kind: 'computed',
      readable: true,
      schema: { type: 'string', nullable: true },
    }),
  );
  expect(object.compute?.example).toBe('SELECT COUNT(*) FROM self."events"');
  expect(JSON.stringify(object)).not.toContain('SELECT MIN(secret)');
  expect(JSON.stringify(object)).not.toContain('"sql"');
  expect(Object.isFrozen(object.datasets!.events!.columns.amount)).toBe(true);
  expect(view.describeObject('customer')).toBe(object);
});

it('keeps denied columns visible but omits hidden correlations and properties', async () => {
  const object = (await discovery(['reader', 'analyst'])).describeObject(
    'customer',
  )!;

  expect(object.datasets?.events?.columns.secret).toMatchObject({
    readable: false,
    description: 'Restricted event detail.',
  });
  expect(object.datasets?.events).not.toHaveProperty('correlation');
  expect(object.properties.map((property) => property.name)).toEqual([
    'id',
    'count',
  ]);
  expect(
    object.properties.find((property) => property.name === 'count'),
  ).toMatchObject({ readable: false });
  expect(JSON.stringify(object)).not.toContain('customer.key');
});

it('omits hidden associations while retaining accessible calculation identities and their access status', async () => {
  const object = (await discovery(['reader', 'private'])).describeObject(
    'customer',
  )!;

  expect(object).not.toHaveProperty('datasets');
  expect(object.compute).not.toHaveProperty('example');
  expect(
    object.properties.filter((property) => property.kind === 'computed'),
  ).toHaveLength(2);
  expect(
    object.properties
      .filter((property) => property.kind === 'computed')
      .every((property) => !property.readable),
  ).toBe(true);
  expect(JSON.stringify(object)).not.toContain('customer.events');
  expect(JSON.stringify(object)).not.toContain('Customer events.');
});

it('does not disclose analytical metadata for an unreadable object', async () => {
  const view = await discovery(['analyst', 'private']);

  expect(view.describeObject('customer')).toBeUndefined();
  expect(view.describe().objects).toEqual({});
});
