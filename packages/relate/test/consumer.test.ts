import { expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  defineAccess,
  defineAction,
  defineGraph,
  defineObject,
  defineRelationship,
  defineSource,
  from,
  nativeMembership,
  native,
  objectId,
  reference,
  source,
} from 'relate';
import type { ObjectId } from 'relate';
import { createConsumer } from 'relate/consumer';
import { compile } from 'relate/compiler';
import { ActionError, ReadError } from '@relate/protocol';
import type {
  ActionDescription,
  ConsumerOperations,
  GraphDescription,
  ObjectDescription,
  ObjectRecord,
  Page,
} from '@relate/protocol';

/** A graph with one traversal in each direction and one action. */
function createGraph() {
  const access = defineAccess({
    roles: ['reader'],
    claims: {},
    fieldGroups: ['ordinary'],
  });
  const customers = defineSource({
    id: 'crm.customers',
    idField: 'id',
    schema: z.object({ id: z.string(), name: z.string() }),
  });
  const Customer = defineObject({
    id: 'customer',
    membership: source(customers),
    properties: {
      id: objectId({ id: 'customer.id' }),
      name: from(customers.fields.name, { id: 'customer.name' }),
    },
  });
  const Review = defineObject({
    id: 'review',
    membership: nativeMembership(),
    properties: {
      id: objectId({ id: 'review.id' }),
      customer: reference(Customer, { id: 'review.customer' }),
      note: native(z.string(), { id: 'review.note' }),
    },
  });
  const AddReview = defineAction({
    id: 'add-review',
    input: z.object({ customer: z.string(), note: z.string() }),
    output: z.object({ review: z.string() }),
    creates: [Review],
    policy: { execute: access.role('reader') },
  });
  const graph = defineGraph({
    id: 'graph',
    objects: { Customer, Review },
    relationships: {
      reviews: defineRelationship({
        id: 'customer-reviews',
        forward: 'reviews',
        reverse: 'customer',
        via: Review.properties.customer,
      }),
    },
    actions: { addReview: AddReview },
    access,
    policies: {
      Customer: { read: { gate: access.role('reader') } },
      Review: { read: { gate: access.role('reader') } },
    },
  });

  return { graph, Customer, Review, AddReview };
}

const graphDescription: GraphDescription = {
  definitionId: 'graph',
  definitionRevision: 'sha256:test',
  objects: [],
  actions: [],
  operations: {
    get: {
      signature: '',
      returns: '',
      description: '',
      options: ['select', 'evidence'],
    },
    query: {
      signature: '',
      returns: '',
      description: '',
      collectionScope: 'graph-membership',
      options: ['where', 'select', 'limit', 'cursor'],
    },
    traverse: {
      description: '',
      many: {
        signature: '',
        returns: '',
        description: '',
        options: ['select', 'limit', 'cursor'],
      },
      one: { signature: '', returns: '', description: '', options: ['select'] },
    },
    options: [],
    shapes: {
      ObjectId: '',
      ObjectResult: '',
      ObjectRecord: '',
      ReadMeta: '',
      Page: '',
      QueryResult: '',
    },
    errors: '',
  },
};

const customerDetail: ObjectDescription = Object.freeze({
  definitionId: 'customer',
  apiName: 'Customer',
  label: 'Customer',
  pluralLabel: 'Customers',
  operations: {
    get: { returns: 'Promise<ObjectResult<Customer>>' },
    query: {
      returns: 'QueryResult<Customer>',
      collectionScope: 'graph-membership' as const,
    },
  },
  properties: [],
  traversals: [
    {
      relationshipDefinitionId: 'customer-reviews',
      name: 'reviews',
      cardinality: 'many' as const,
      target: {
        definitionId: 'review',
        apiName: 'Review',
        label: 'Review',
        pluralLabel: 'Reviews',
      },
      returns: 'QueryResult<Review>',
    },
  ],
});

const actionDetail: ActionDescription = {
  definitionId: 'add-review',
  apiName: 'addReview',
  input: [],
  output: [],
  errors: {},
  creates: [],
};

const record = (id: string): ObjectRecord => ({
  id,
  data: { note: 'n' },
  meta: {
    evidence: 'compact',
    completeness: 'complete',
    degraded: false,
    definitionRevision: 'sha256:test',
  },
});

const finalPage = (...ids: string[]): Page<ObjectRecord> => ({
  data: ids.map(record),
  meta: { exhausted: true },
});

/** Every operation records its call; results are plain protocol values. */
function createOperations(graph: ReturnType<typeof createGraph>['graph']) {
  const definitionRevision = compile(graph).definitionRevision;
  const operations = {
    discovery: {
      describe: vi.fn(() => ({ ...graphDescription, definitionRevision })),
      describeObject: vi.fn((id: string) =>
        id === 'customer' ? customerDetail : undefined,
      ),
      describeAction: vi.fn((id: string) =>
        id === 'add-review' ? actionDetail : undefined,
      ),
    },
    get: vi.fn<ConsumerOperations['get']>(async (_type, id) => ({
      status: 'ok',
      id,
      data: { name: 'Ada' },
      meta: { ...record(id).meta, definitionRevision },
    })),
    query: vi.fn<ConsumerOperations['query']>(async () =>
      finalPage('r1', 'r2'),
    ),
    traverse: vi.fn<ConsumerOperations['traverse']>(
      async (_type, _id, traversal) =>
        traversal === 'customer'
          ? {
              status: 'ok',
              id: 'c1',
              data: { name: 'Ada' },
              meta: record('c1').meta,
            }
          : finalPage('r1'),
    ),
    invoke: vi.fn<ConsumerOperations['invoke']>(async () => ({
      invocationId: 'inv-1',
      state: 'succeeded',
      output: { review: 'r1' },
    })),
    getReceipt: vi.fn<ConsumerOperations['getReceipt']>(async () => ({
      invocationId: 'inv-1',
      state: 'succeeded',
      output: { review: 'r1' },
    })),
  } satisfies ConsumerOperations;

  return operations;
}

it('routes typed calls to definition IDs and passes complete results through', async () => {
  const { graph } = createGraph();
  const operations = createOperations(graph);
  const consumer = createConsumer(compile(graph).consumer, operations);
  const id = 'c1' as ObjectId<'customer'>;

  const customer = await consumer.objects.Customer.get(id, {
    select: ['name'],
  });

  expect(operations.get).toHaveBeenCalledWith('customer', 'c1', {
    select: ['name'],
  });
  expect(customer).toEqual(await operations.get.mock.results[0]!.value);
  expect(customer).toMatchObject({
    status: 'ok',
    id: 'c1',
    data: { name: 'Ada' },
  });

  const page = await consumer.objects.Review.query({ where: { note: 'n' } });

  expect(operations.query).toHaveBeenCalledWith('review', {
    where: { note: 'n' },
  });
  expect(page.data.map((review) => review.id)).toEqual(['r1', 'r2']);
});

it('pages to-many traversals and awaits to-one traversals by cardinality', async () => {
  const { graph } = createGraph();
  const operations = createOperations(graph);
  const consumer = createConsumer(compile(graph).consumer, operations);
  const customerId = 'c1' as ObjectId<'customer'>;
  const reviewId = 'r1' as ObjectId<'review'>;

  const reviews: string[] = [];

  for await (const review of consumer.objects.Customer.traverse.reviews(
    customerId,
    { limit: 10 },
  ))
    reviews.push(review.id);

  expect(reviews).toEqual(['r1']);
  expect(operations.traverse).toHaveBeenCalledWith(
    'customer',
    'c1',
    'reviews',
    {
      limit: 10,
    },
  );

  const customer = await consumer.objects.Review.traverse.customer(reviewId);

  expect(customer).toMatchObject({ status: 'ok', id: 'c1' });
  expect(operations.traverse).toHaveBeenCalledWith(
    'review',
    'r1',
    'customer',
    {},
  );
});

it('rejects operations whose result shape does not match the traversal cardinality', async () => {
  const { graph } = createGraph();
  const operations = createOperations(graph);

  operations.traverse.mockImplementation(async (_t, _i, traversal) =>
    traversal === 'customer' ? finalPage('c1') : { status: 'not-found' },
  );

  const consumer = createConsumer(compile(graph).consumer, operations);

  await expect(
    consumer.objects.Review.traverse.customer('r1' as ObjectId<'review'>),
  ).rejects.toThrow('Invalid to-one traversal result');
  await expect(
    consumer.objects.Customer.traverse.reviews('c1' as ObjectId<'customer'>),
  ).rejects.toThrow('Invalid to-many traversal result');
});

it('rejects paged options that are not plain data through the handle, not synchronously', async () => {
  const { graph } = createGraph();
  const operations = createOperations(graph);
  const consumer = createConsumer(compile(graph).consumer, operations);

  const handle = consumer.objects.Review.query({
    where: { note: () => 'n' } as never,
  });

  await expect(handle).rejects.toMatchObject({
    name: 'ReadError',
    code: 'invalid-request',
    operation: 'Review.query',
  });
  expect(operations.query).not.toHaveBeenCalled();
});

it('decorates discovery with this facade’s call paths and asks discovery every time', () => {
  const { graph } = createGraph();
  const operations = createOperations(graph);
  const consumer = createConsumer(compile(graph).consumer, operations);

  expect(consumer.describe()).toEqual({
    ...graphDescription,
    definitionRevision: compile(graph).definitionRevision,
  });

  const detail = consumer.objects.Customer.describe();

  expect(detail?.operations.get.call).toBe(
    'objects.Customer.get(id, options?)',
  );
  expect(detail?.operations.query.call).toBe(
    'objects.Customer.query(options?)',
  );
  expect(detail?.traversals[0]?.call).toBe(
    'objects.Customer.traverse.reviews(id, options?)',
  );
  expect(consumer.objects.Customer.describe()).toBe(detail);
  expect(operations.discovery.describeObject).toHaveBeenCalledTimes(2);
  expect(consumer.objects.Review.describe()).toBeUndefined();
  expect(consumer.actions.addReview.describe()).toBe(actionDetail);

  expect(String(consumer.objects.Customer.get)).toBe(
    'objects.Customer.get(id: ObjectId<Customer>, options?: { select?, evidence? }): Promise<ObjectResult<Customer>>',
  );
  expect(String(consumer.objects.Customer.traverse.reviews)).toBe(
    'objects.Customer.traverse.reviews(id: ObjectId<Customer>, options?: { select?, limit?, cursor? }): QueryResult<Review>',
  );
  expect(String(consumer.objects.Review.traverse.customer)).toBe(
    'objects.Review.traverse.customer(id: ObjectId<Review>, options?: { select? }): Promise<ObjectResult<Customer>>',
  );
});

it('prints operations without option names when discovery is unavailable', () => {
  const { graph } = createGraph();
  const operations = createOperations(graph);

  const consumer = createConsumer(compile(graph).consumer, operations);

  operations.discovery.describe.mockImplementation(() => {
    throw new Error('Relate is closed');
  });

  expect(String(consumer.objects.Review.query)).toBe(
    'objects.Review.query(options?: { … }): QueryResult<Review>',
  );
  expect(() => consumer.describe()).toThrow('closed');
});

it('invokes registered actions and only looks up receipts of registered actions', async () => {
  const { graph } = createGraph();
  const operations = createOperations(graph);
  const consumer = createConsumer(compile(graph).consumer, operations);

  const receipt = await consumer.actions.addReview({
    input: { customer: 'c1', note: 'Follow up' },
    idempotencyKey: 'k1',
  });

  expect(operations.invoke).toHaveBeenCalledWith('add-review', {
    input: { customer: 'c1', note: 'Follow up' },
    idempotencyKey: 'k1',
  });
  expect(receipt.state).toBe('succeeded');

  await expect(
    consumer.receipts.get('addReview', 'inv-1'),
  ).resolves.toMatchObject({
    invocationId: 'inv-1',
  });
  expect(operations.getReceipt).toHaveBeenCalledWith('add-review', 'inv-1');

  await expect(
    consumer.receipts.get('foreign' as never, 'inv-1'),
  ).rejects.toBeInstanceOf(ActionError);
  expect(operations.getReceipt).toHaveBeenCalledTimes(1);
});

it('surfaces operation failures unchanged', async () => {
  const { graph } = createGraph();
  const operations = createOperations(graph);

  operations.get.mockRejectedValue(new ReadError('unavailable'));

  const consumer = createConsumer(compile(graph).consumer, operations);

  await expect(
    consumer.objects.Customer.get('c1' as ObjectId<'customer'>),
  ).rejects.toMatchObject({ name: 'ReadError', code: 'unavailable' });
});

it('reduces an authored graph to the frozen routing description the facade needs', () => {
  const { graph } = createGraph();

  const description = compile(graph).consumer;

  expect(description).toEqual({
    formatVersion: 1,
    graphDefinitionId: 'graph',
    definitionRevision: compile(graph).definitionRevision,
    objects: {
      Customer: {
        definitionId: 'customer',
        traversals: { reviews: { cardinality: 'many', target: 'Review' } },
      },
      Review: {
        definitionId: 'review',
        traversals: { customer: { cardinality: 'one', target: 'Customer' } },
      },
    },
    actions: { addReview: { definitionId: 'add-review' } },
  });
  expect(Object.isFrozen(description)).toBe(true);
  expect(Object.isFrozen(description.objects.Customer!.traversals)).toBe(true);
  // Nothing from authoring leaks: no schemas, access, policies or definitions.
  expect(JSON.parse(JSON.stringify(description))).toEqual(description);
});

it('builds the same facade from serialized and compiler-produced descriptions', async () => {
  const { graph } = createGraph();
  const operations = createOperations(graph);
  const fromDescription = createConsumer<typeof graph>(
    JSON.parse(JSON.stringify(compile(graph).consumer)),
    operations,
  );
  const fromGraph = createConsumer(compile(graph).consumer, operations);
  const id = 'c1' as ObjectId<'customer'>;

  expect(Object.keys(fromDescription.objects)).toEqual(
    Object.keys(fromGraph.objects),
  );
  expect(Object.keys(fromDescription.objects.Customer.traverse)).toEqual([
    'reviews',
  ]);
  expect(String(fromDescription.objects.Review.traverse.customer)).toBe(
    String(fromGraph.objects.Review.traverse.customer),
  );
  await expect(fromDescription.objects.Customer.get(id)).resolves.toEqual(
    await fromGraph.objects.Customer.get(id),
  );
  // Receipt lookup needs only the registry name, without authored definitions.
  await expect(
    fromDescription.receipts.get('addReview', 'inv-1'),
  ).resolves.toMatchObject({ invocationId: 'inv-1' });
});

it('rejects a relationship whose endpoint is not a registered object', () => {
  const { graph, Customer } = createGraph();
  const stranger = defineObject({
    id: 'stranger',
    membership: nativeMembership(),
    properties: {
      id: objectId({ id: 'stranger.id' }),
      customer: reference(Customer, { id: 'stranger.customer' }),
    },
  });

  expect(() =>
    compile({
      ...graph,
      relationships: {
        strangers: defineRelationship({
          id: 'customer-strangers',
          forward: 'strangers',
          reverse: 'customer',
          via: stranger.properties.customer,
        }),
      },
    }),
  ).toThrow();
});

it('captures JSON routing without freezing or retaining caller-owned maps', async () => {
  const { graph } = createGraph();
  const description = JSON.parse(JSON.stringify(compile(graph).consumer));
  const operations = createOperations(graph);
  const consumer = createConsumer<typeof graph>(description, operations);

  description.objects.Customer.definitionId = 'other';
  description.objects.Customer.traversals.reviews.cardinality = 'one';
  description.objects.Customer.traversals.reviews.target = 'Customer';
  description.actions.addReview.definitionId = 'other-action';
  delete description.objects.Review;

  const handle = consumer.objects.Customer.traverse.reviews(
    'c1' as ObjectId<'customer'>,
  );
  const ids: string[] = [];

  for await (const item of handle) ids.push(item.id);

  expect(ids).toEqual(['r1']);
  expect(String(consumer.objects.Customer.traverse.reviews)).toContain(
    'QueryResult<Review>',
  );
  await consumer.receipts.get('addReview', 'inv-1');
  expect(operations.getReceipt).toHaveBeenCalledWith('add-review', 'inv-1');
  await consumer.objects.Customer.get('c1' as ObjectId<'customer'>);
  expect(operations.get).toHaveBeenCalledWith('customer', 'c1', {});
});

it('rejects malformed loaded descriptions at construction with a description error', () => {
  const { graph } = createGraph();
  const operations = createOperations(graph);

  for (const change of [
    (d: any) => {
      delete d.actions;
    },
    (d: any) => {
      delete d.objects.Customer.traversals;
    },
    (d: any) => {
      d.formatVersion = 2;
    },
    (d: any) => {
      d.definitionRevision = 'wrong';
    },
    (d: any) => {
      d.objects.Customer.definitionId = 'review';
    },
    (d: any) => {
      d.objects.Customer.traversals.reviews.target = 'Missing';
    },
    (d: any) => {
      d.objects.Customer.traversals.reviews.cardinality = 'some';
    },
    (d: any) => {
      Object.defineProperty(d.objects.Customer.traversals, '__proto__', {
        value: { cardinality: 'one', target: 'Review' },
        enumerable: true,
      });
    },
  ]) {
    const description = JSON.parse(JSON.stringify(compile(graph).consumer));

    change(description);
    expect(() => createConsumer(description, operations)).toThrow(
      'Invalid consumer description',
    );
  }

  // Authored graphs are no longer guessed to be descriptions.
  expect(() => createConsumer(graph as never, operations)).toThrow(
    'Invalid consumer description',
  );
});

it('rejects a different model before dispatching any operation', () => {
  const { graph, Review } = createGraph();
  const description = compile(graph).consumer;
  const changedReview = defineObject({
    ...Review,
    properties: {
      ...Review.properties,
      note: native(z.number(), { id: 'review.note' }),
    },
  });
  const changed = compile({
    ...graph,
    objects: { ...graph.objects, Review: changedReview },
    relationships: {
      reviews: defineRelationship({
        id: 'customer-reviews',
        forward: 'reviews',
        reverse: 'customer',
        via: changedReview.properties.customer,
      }),
    },
    actions: {},
  });
  const operations = createOperations(graph);

  operations.discovery.describe.mockReturnValue({
    ...graphDescription,
    definitionRevision: changed.definitionRevision,
  });
  expect(() => createConsumer(description, operations)).toThrow(
    'does not match',
  );
  operations.discovery.describe.mockReturnValue({
    ...graphDescription,
    definitionId: 'other-graph',
    definitionRevision: description.definitionRevision,
  });
  expect(() => createConsumer(description, operations)).toThrow(
    'does not match',
  );
  expect(operations.get).not.toHaveBeenCalled();
  expect(operations.invoke).not.toHaveBeenCalled();
});

it('turns synchronous get and action failures into promise rejections', async () => {
  const { graph } = createGraph();
  const operations = createOperations(graph);
  const consumer = createConsumer(compile(graph).consumer, operations);

  operations.get.mockImplementation(() => {
    throw new Error('closed');
  });
  operations.invoke.mockImplementation(() => {
    throw new Error('closed');
  });

  const get = consumer.objects.Customer.get('c1' as ObjectId<'customer'>);
  const action = consumer.actions.addReview({
    input: { customer: 'c1', note: 'n' },
    idempotencyKey: 'k',
  });

  await expect(get).rejects.toThrow('closed');
  await expect(action).rejects.toThrow('closed');
});

it('exports empty maps for a graph with no actions or relationships', () => {
  const { graph, Customer } = createGraph();
  const model = compile(
    defineGraph({
      id: 'empty-edges',
      objects: { Customer },
      access: graph.access,
      policies: { Customer: { read: 'deny' } },
    }),
  );
  const operations = createOperations(graph);

  operations.discovery.describe.mockReturnValue({
    ...graphDescription,
    definitionId: 'empty-edges',
    definitionRevision: model.definitionRevision,
  });
  const consumer = createConsumer(model.consumer, operations);

  expect(consumer.actions).toEqual({});
  expect(consumer.objects.Customer.traverse).toEqual({});
});

it('refuses invalid traversals before producing a consumer artifact', () => {
  const { graph, Review } = createGraph();

  for (const name of ['__proto__', 'reviews'])
    expect(() =>
      compile({
        ...graph,
        relationships: {
          ...graph.relationships,
          other: defineRelationship({
            id: 'other',
            via: Review.properties.customer,
            forward: name,
            reverse: 'otherCustomer',
          }),
        },
      }),
    ).toThrow('Invalid or duplicate traversal name');
});
