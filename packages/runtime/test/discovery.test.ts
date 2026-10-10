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
import type { Principal } from '@relate/runtime';
import type { GraphDefinition } from 'relate';
import { createInvoiceGraph } from '../../../tests/support/invoice-graph.js';
import {
  ana as manager,
  graph as actionGraph,
} from '../../../tests/support/native-action-model.js';

/** Discovery over a freshly compiled model and its revision. */
function discover(graph: GraphDefinition, principal: Principal) {
  const model = compile(graph);

  return createDiscovery(model.manifest, model.definitionRevision, principal);
}

it('describes only the objects, fields, traversals, and actions available to an actor', () => {
  const { ana, finance, graph, Customer, Invoice } = createInvoiceGraph();
  const employee = discover(graph, ana);

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
    operations: {
      get: { returns: 'Promise<ObjectResult<Customer>>' },
      query: {
        returns: 'QueryResult<Customer>',
        collectionScope: 'graph-membership',
      },
    },
    properties: [
      { name: 'id', kind: 'object-id', filter: 'Customer object ID' },
      {
        name: 'name',
        kind: 'value',
        description: 'Registered business name.',
        filter: 'string',
      },
      { name: 'portfolio', kind: 'value', filter: 'string' },
    ],
    traversals: [
      {
        name: 'invoices',
        cardinality: 'many',
        description: 'Invoices billed to this customer.',
        target: { apiName: 'Invoice' },
        returns: 'QueryResult<Invoice>',
      },
    ],
  });
  expect(employee.describeObject(Invoice.id)?.properties).toContainEqual(
    expect.objectContaining({
      name: 'customer',
      kind: 'reference',
      description: 'Customer billed by this invoice.',
      filter: 'Customer object ID',
    }),
  );
  expect(employee.describeObject(Customer.id)?.properties).not.toContainEqual(
    expect.objectContaining({ name: 'revenue' }),
  );
  expect(
    discover(graph, finance).describeObject(Customer.id)?.properties,
  ).toContainEqual(
    expect.objectContaining({
      name: 'revenue',
      description: 'Lifetime revenue in minor currency units.',
    }),
  );

  const outsider = discover(graph, {
    id: 'outsider',
    roles: [],
    claims: {},
  });

  expect(outsider.describe().objects).toEqual([]);
  // The read contract is SDK-owned: identical for every graph and actor.
  expect(outsider.describe().operations).toBe(employee.describe().operations);
  expect(outsider.describeObject(Customer.id)).toBeUndefined();

  const actions = discover(actionGraph, manager);

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
    discover(actionGraph, {
      ...manager,
      roles: ['employee'],
    }).describe().actions,
  ).toEqual([]);
});

it('returns frozen discovery values detached from the compiled manifest', () => {
  const { ana, graph, Customer } = createInvoiceGraph();
  const discovery = discover(graph, ana);
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
  const discovery = discover(graph, {
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
