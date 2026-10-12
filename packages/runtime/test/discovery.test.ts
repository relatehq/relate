import { expect, it } from 'vitest';
import { z } from 'zod';
import {
  defineAccess,
  defineAction,
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
  access as actionAccess,
  ana as manager,
  graph as actionGraph,
} from '../../../tests/support/native-action-model.js';

/** Discovery over a freshly compiled model and its revision. */
function discover(graph: GraphDefinition, principal: Principal) {
  const model = compile(graph);

  return createDiscovery(model, principal);
}

it('describes only the objects, fields, traversals, and actions available to an actor', () => {
  const { ana, finance, graph, Customer, Invoice } = createInvoiceGraph();
  const employee = discover(graph, ana);

  expect(employee.describe()).toMatchObject({
    definitionId: 'invoice-read',
    description: 'Customer accounts and their invoices.',
    objects: {
      Customer: {
        description: 'Organizations that buy our services.',
        traversals: {
          invoices: {
            target: 'Invoice',
            cardinality: 'many',
            description: 'Invoices billed to this customer.',
          },
        },
      },
      Invoice: {
        description: 'Amounts billed to customers.',
        traversals: {
          customer: {
            target: 'Customer',
            cardinality: 'one',
            description: 'Customer billed by this invoice.',
          },
        },
      },
    },
    actions: {},
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

  expect(outsider.describe().objects).toEqual({});
  // The read contract is SDK-owned: identical for every graph and actor.
  expect(outsider.describe().sdk).toBe(employee.describe().sdk);
  expect(outsider.describeObject(Customer.id)).toBeUndefined();

  const actions = discover(actionGraph, manager);

  expect(actions.describe().actions).toEqual({
    addAccountReview: {
      description: 'Record a new assessment of a customer account.',
      creates: ['AccountReview'],
    },
  });
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
  ).toEqual({});
});

it('returns frozen discovery values detached from the compiled manifest', () => {
  const { ana, graph, Customer } = createInvoiceGraph();
  const discovery = discover(graph, ana);
  const object = discovery.describeObject(Customer.id)!;

  const overview = discovery.describe();

  expect(Object.isFrozen(overview)).toBe(true);
  expect(Object.isFrozen(overview.objects.Customer?.traversals.invoices)).toBe(
    true,
  );
  expect(Object.isFrozen(overview.sdk.options)).toBe(true);
  expect(() =>
    Object.assign(overview.objects.Customer!.traversals.invoices!, {
      target: 'Secret',
    }),
  ).toThrow();
  expect(() =>
    Object.assign(overview.sdk.options, { limit: 'unlimited' }),
  ).toThrow();
  expect(discovery.describe()).toBe(overview);
  expect(Object.isFrozen(object.properties)).toBe(true);
  expect(() => (object.properties as unknown[]).push({})).toThrow();
});

function createPeopleGraph(restrictLinks = false) {
  const access = defineAccess({
    roles: ['reader', 'link-reader'],
    fieldGroups: ['ordinary', 'restricted'],
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
        ...(restrictLinks ? { access: access.groups.restricted } : {}),
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
    policies: {
      Person: read,
      Follow: { ...read, groups: { restricted: access.role('link-reader') } },
      Note: read,
    },
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
  expect(discovery.describe().objects.Person?.traversals).toEqual({
    following: { target: 'Person', cardinality: 'many' },
    followers: { target: 'Person', cardinality: 'many' },
  });
  expect(discovery.describe().objects.Note).toEqual({ traversals: {} });
});

it('omits overview links when a destination or linking field is hidden', () => {
  const { graph, access, ana } = createInvoiceGraph();
  const hiddenInvoice = defineGraph({
    ...graph,
    policies: {
      ...graph.policies,
      Invoice: { read: { gate: access.role('finance') } },
    },
  });
  const restricted = createPeopleGraph(true);

  const overview = discover(hiddenInvoice, ana).describe();
  const people = discover(restricted.graph, {
    id: 'reader',
    roles: ['reader'],
    claims: {},
  });

  expect(overview.objects).toEqual({
    Customer: {
      description: 'Organizations that buy our services.',
      traversals: {},
    },
  });
  expect(people.describe().objects.Person?.traversals).toEqual({});
  expect(people.describeObject(restricted.Person.id)?.traversals).toEqual([]);
});

it('omits hidden created types and actions with unreadable input references', () => {
  const hiddenReview = defineGraph({
    ...actionGraph,
    policies: {
      ...actionGraph.policies,
      AccountReview: {
        ...actionGraph.policies.AccountReview,
        read: { gate: actionAccess.role('finance') },
      },
    },
  });
  const hiddenCustomer = defineGraph({
    ...actionGraph,
    policies: {
      ...actionGraph.policies,
      Customer: { read: { gate: actionAccess.role('finance') } },
    },
  });

  const overview = discover(hiddenReview, manager).describe();
  const denied = discover(hiddenCustomer, manager).describe();

  expect(overview.objects).not.toHaveProperty('AccountReview');
  expect(overview.actions.addAccountReview).toEqual({
    description: 'Record a new assessment of a customer account.',
    creates: [],
  });
  expect(denied.actions).toEqual({});
});

it('serializes a complete compact overview without schemas or verbose contracts', () => {
  const { graph, ana } = createInvoiceGraph();

  const overview = discover(graph, ana).describe();
  const json = JSON.stringify(overview);

  expect(JSON.parse(json)).toEqual(overview);
  expect(Object.keys(overview)).toEqual([
    'definitionId',
    'definitionRevision',
    'description',
    'objects',
    'actions',
    'sdk',
  ]);
  expect(Object.keys(overview.objects)).toEqual(['Customer', 'Invoice']);
  expect(json).not.toContain('crm.customers');
  expect(json).not.toContain('portfolio');
  expect(json).not.toContain('revenue');
  expect(overview.sdk).not.toHaveProperty('errors');
  // A small graph used to spend over 5 KB on shared documentation alone.
  expect(Buffer.byteLength(json)).toBeLessThan(4_000);
  expect(overview.sdk.reads.query).toBe(
    'await objects.<Object>.query(options?)',
  );
  expect(overview.sdk.results.pagination).toContain('even if a page is empty');
  expect(overview.sdk.semantics).toContain(
    'Queries enumerate records already in this graph.',
  );
});

it('keeps every visible object and action in larger overviews', () => {
  const access = defineAccess({
    roles: ['reader'],
    fieldGroups: ['ordinary'],
    claims: {},
  });
  const objects = Object.fromEntries(
    Array.from({ length: 120 }, (_, i) => [
      `Object${i}`,
      defineObject({
        id: `object-${i}`,
        membership: nativeMembership(),
        properties: { id: objectId({ id: `object-${i}.id` }) },
      }),
    ]),
  );
  const actions = Object.fromEntries(
    Array.from({ length: 110 }, (_, i) => [
      `action${i}`,
      defineAction({
        id: `action-${i}`,
        input: z.object({}),
        output: z.object({}),
        creates: [],
        policy: { execute: access.role('reader') },
      }),
    ]),
  );
  const graph = defineGraph({
    id: 'large-overview',
    objects,
    actions,
    access,
    policies: Object.fromEntries(
      Object.keys(objects).map((name) => [
        name,
        { read: { gate: access.role('reader') } },
      ]),
    ),
  });

  const overview = discover(graph, {
    id: 'reader',
    roles: ['reader'],
    claims: {},
  }).describe();

  expect(Object.keys(overview.objects).sort()).toEqual(
    Object.keys(objects).sort(),
  );
  expect(Object.keys(overview.actions).sort()).toEqual(
    Object.keys(actions).sort(),
  );
  expect(overview.objects.Object119).toEqual({ traversals: {} });
  expect(overview.actions.action109).toEqual({ creates: [] });
});
