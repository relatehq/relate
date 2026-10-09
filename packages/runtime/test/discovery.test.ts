import { expect, it } from 'vitest';
import { z } from 'zod';
import {
  defineAccess,
  defineGraph,
  defineObject,
  defineRelationship,
  defineSource,
  nativeMembership,
  objectId,
  reference,
  source,
} from 'relate';
import { compile } from 'relate/compiler';
import { createDiscovery } from '@relate/runtime';
import { createInvoiceGraph } from '../../../tests/support/invoice-graph.js';
import {
  ana as manager,
  graph as actionGraph,
} from '../../../tests/support/native-action-model.js';

it('describes only the objects, fields, traversals, and actions available to an actor', () => {
  const { ana, finance, graph, Customer, Invoice } = createInvoiceGraph();
  const employee = createDiscovery(compile(graph).manifest, ana);

  expect(employee.describe()).toMatchObject({
    definitionId: 'invoice-read',
    description: 'Customer accounts and their invoices.',
    objects: [
      {
        apiName: 'Customer',
        description: 'Organizations that buy our services.',
      },
      { apiName: 'Invoice', description: 'Amounts billed to customers.' },
    ],
    actions: [],
  });
  expect(employee.describeObject(Customer.id)).toMatchObject({
    apiName: 'Customer',
    operations: { get: true, query: { collectionScope: 'graph-membership' } },
    properties: [
      { name: 'id', kind: 'object-id' },
      { name: 'name', kind: 'value', description: 'Registered business name.' },
      { name: 'portfolio', kind: 'value' },
    ],
    traversals: [
      {
        name: 'invoices',
        cardinality: 'many',
        description: 'Invoices billed to this customer.',
        target: { apiName: 'Invoice' },
      },
    ],
  });
  expect(employee.describeObject(Invoice.id)?.properties).toContainEqual(
    expect.objectContaining({
      name: 'customer',
      kind: 'reference',
      description: 'Customer billed by this invoice.',
    }),
  );
  expect(employee.describeObject(Customer.id)?.properties).not.toContainEqual(
    expect.objectContaining({ name: 'revenue' }),
  );
  expect(
    createDiscovery(compile(graph).manifest, finance).describeObject(
      Customer.id,
    )?.properties,
  ).toContainEqual(
    expect.objectContaining({
      name: 'revenue',
      description: 'Lifetime revenue in minor currency units.',
    }),
  );

  const outsider = createDiscovery(compile(graph).manifest, {
    id: 'outsider',
    roles: [],
    claims: {},
  });

  expect(outsider.describe().objects).toEqual([]);
  expect(outsider.describeObject(Customer.id)).toBeUndefined();

  const actions = createDiscovery(compile(actionGraph).manifest, manager);

  expect(actions.describe().actions).toEqual([
    {
      definitionId: 'business.add-account-review',
      apiName: 'addAccountReview',
      description: 'Record a new assessment of a customer account.',
    },
  ]);
  expect(actions.describeAction('business.add-account-review')).toMatchObject({
    input: [
      {
        name: 'customer',
        description: 'Customer being reviewed.',
        references: { apiName: 'Customer' },
      },
      {
        name: 'note',
        description: 'Assessment and recommended next steps.',
      },
    ],
    output: [
      {
        name: 'reviewId',
        description: 'New account review ID.',
        references: { apiName: 'AccountReview' },
      },
    ],
  });
  expect(
    createDiscovery(compile(actionGraph).manifest, {
      ...manager,
      roles: ['employee'],
    }).describe().actions,
  ).toEqual([]);
});

it('returns frozen discovery values detached from the compiled manifest', () => {
  const { ana, graph, Customer } = createInvoiceGraph();
  const discovery = createDiscovery(compile(graph).manifest, ana);
  const object = discovery.describeObject(Customer.id)!;

  expect(Object.isFrozen(discovery.describe())).toBe(true);
  expect(Object.isFrozen(object.properties)).toBe(true);
  expect(() => (object.properties as unknown[]).push({})).toThrow();
});

function createPeopleGraph() {
  const access = defineAccess({
    roles: ['reader'],
    fieldGroups: ['ordinary'],
    claims: {},
  });
  const people = defineSource({
    id: 'hr.people',
    idField: 'id',
    schema: z.object({ id: z.string() }),
  });
  const follows = defineSource({
    id: 'hr.follows',
    idField: 'id',
    schema: z.object({
      id: z.string(),
      follower: z.string(),
      followee: z.string(),
    }),
  });
  const Person = defineObject({
    id: 'person',
    membership: source(people),
    properties: { id: objectId({ id: 'person.id' }) },
  });
  const Follow = defineObject({
    id: 'follow',
    membership: source(follows),
    properties: {
      id: objectId({ id: 'follow.id' }),
      follower: reference(Person, {
        id: 'follow.follower',
        from: follows.fields.follower,
      }),
      followee: reference(Person, {
        id: 'follow.followee',
        from: follows.fields.followee,
      }),
    },
  });
  const Note = defineObject({
    id: 'note',
    membership: nativeMembership(),
    properties: {
      id: objectId({ id: 'note.id' }),
      subject: reference(Person, { id: 'note.subject' }),
    },
  });
  const read = { read: { gate: access.role('reader') } };
  const graph = defineGraph({
    id: 'people',
    objects: { Person, Follow, Note },
    relationships: {
      Following: defineRelationship({
        id: 'person.following',
        forward: 'following',
        reverse: 'followers',
        through: {
          from: Follow.properties.follower,
          to: Follow.properties.followee,
        },
      }),
      PersonNotes: defineRelationship({
        id: 'person.notes',
        forward: 'notes',
        reverse: 'subject',
        via: Note.properties.subject,
      }),
    },
    access,
    policies: { Person: read, Follow: read, Note: read },
  });

  return { graph, Person, Note };
}

it('describes exactly the traversals the runtime executes', () => {
  const { graph, Person, Note } = createPeopleGraph();
  const discovery = createDiscovery(compile(graph).manifest, {
    id: 'reader',
    roles: ['reader'],
    claims: {},
  });

  // A self-relationship has both directions; a native-owned link has no scan.
  expect(
    discovery.describeObject(Person.id)?.traversals.map((t) => t.name),
  ).toEqual(['following', 'followers']);
  expect(discovery.describeObject(Note.id)?.traversals).toEqual([]);
});
