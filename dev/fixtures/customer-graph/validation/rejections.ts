import { crmCustomers, CustomerInvoices } from '../source/model.js';
/** Compile-time acceptance only. These declarations are never executed. */
import { z } from 'zod';
import {
  defineAction,
  defineAccess,
  connect,
  defineRelationship,
  createRuntime,
  defineGraph,
  createActionImplementer,
} from './target.js';
import { graph } from '../source/graph.js';
import { access } from '../source/access.js';
import {
  objects,
  relationships,
  Customer,
  Invoice,
  AccountReview,
} from '../source/model.js';
import { AddAccountReview } from '../source/actions/add-account-review.js';
import { EscalateAccount } from '../source/actions/escalate-account.js';
import { implementAction } from '../source/actions/implement-action.server.js';
import { addAccountReview } from '../source/actions/add-account-review.server.js';
import { escalateAccount } from '../source/actions/escalate-account.server.js';
import { reviewInvoice } from '../source/actions/review-invoice.server.js';
import { ana, createFixtureApp } from './setup.js';

type Expect<T extends true> = T;

type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
    ? true
    : false;

const consumer = createFixtureApp().as(ana);

export async function reads(id: string) {
  const customer = await consumer.objects.Customer.get(id, {
    select: ['name', 'revenue'],
  });

  if (customer.status !== 'ok') return;

  const selected: Expect<
    Equal<
      typeof customer.data,
      { readonly name?: string; readonly revenue?: number }
    >
  > = true;

  void selected;
  // @ts-expect-error unselected property
  customer.data.portfolio;
  // @ts-expect-error invalid selection
  await consumer.objects.Customer.get(id, { select: ['typo'] });
  // @ts-expect-error unknown object
  consumer.objects.Account;
  const owner = await consumer.objects.Invoice.traverse.customer(id);
  const cardinality: Expect<Equal<typeof owner.status, 'ok' | 'not-found'>> =
    true;

  void cardinality;
  // @ts-expect-error single relationship has no page limit
  await consumer.objects.Invoice.traverse.customer(id, { limit: 10 });

  await consumer.objects.Invoice.query();
  await consumer.objects.Invoice.query({ select: ['id'], limit: 10 });
  const invoices = await consumer.objects.Invoice.query({
    where: { customer: id, status: 'open' },
    select: ['id'],
  });
  const querySelection: Expect<
    Equal<(typeof invoices.data)[number]['data'], { readonly id?: string }>
  > = true;

  void querySelection;
  await consumer.objects.Invoice.query({
    // @ts-expect-error filter value must match field schema
    where: { status: 42 },
  });
  await consumer.objects.Invoice.query({
    // @ts-expect-error unknown filter property
    where: { missing: 'x' },
  });
  // @ts-expect-error invalid query selection
  await consumer.objects.Invoice.query({ select: ['typo'] });
  // @ts-expect-error query replaces list
  consumer.objects.Invoice.list();
  // @ts-expect-error consumers cannot create native records directly
  consumer.objects.AccountReview.create({
    customer: id,
    author: 'ana',
    note: 'n',
  });
}

void consumer.actions.addAccountReview({
  input: { customer: 'c', note: 'n' },
  idempotencyKey: 'k',
});
void consumer.actions.addAccountReview({
  // @ts-expect-error reference input required
  input: { note: 'n' },
  idempotencyKey: 'k',
});
void consumer.actions.addAccountReview({
  // @ts-expect-error target removed from invocation
  target: 'c',
  input: { customer: 'c', note: 'n' },
  idempotencyKey: 'k',
});
// @ts-expect-error idempotency remains required
void consumer.actions.addAccountReview({ input: { customer: 'c', note: 'n' } });
defineAction({
  ...AddAccountReview,
  // @ts-expect-error target removed from definition
  target: Customer,
});
defineAction({
  ...AddAccountReview,
  // @ts-expect-error no upfront fetch declarations
  reads: {},
});
defineAction({
  ...AddAccountReview,
  // @ts-expect-error source-owned types cannot be created natively
  creates: [Invoice],
});

implementAction(AddAccountReview, async (context) => {
  const { input, actor, objects } = context;
  const id: string = input.customer.id;
  const portfolio: string = actor.claims.portfolio;

  void id;
  void portfolio;
  // @ts-expect-error no target context
  context.target;
  // @ts-expect-error no prefetched reads context
  context.reads;
  // @ts-expect-error no deferred change builder
  context.changes;
  // @ts-expect-error references are not loaded records
  input.customer.data;
  // @ts-expect-error unknown claim
  actor.claims.tenant;
  // @ts-expect-error undeclared native creation
  await objects.Task.create({});
  // @ts-expect-error source ownership remains authoritative
  await objects.Customer.create({});
  // @ts-expect-error complete native values required
  await objects.AccountReview.create({ customer: id });
  await objects.AccountReview.create({
    customer: id,
    author: actor.id,
    note: input.note,
    // @ts-expect-error author cannot set allocated ID
    id: 'mine',
  });
  const review = await objects.AccountReview.create({
    customer: id,
    author: actor.id,
    note: input.note,
  });
  const record = await objects.AccountReview.get(review.id, {
    select: ['note'],
  });

  if (record.status === 'ok') {
    const note: string | undefined = record.data.note;

    void note;
    // @ts-expect-error only selected properties available
    record.data.author;
  }

  return { reviewId: review.id };
});
// @ts-expect-error output follows the action schema
implementAction(AddAccountReview, async () => ({ reviewId: 1 }));
implementAction(EscalateAccount, async ({ objects }) => {
  const sameReads: Expect<
    Equal<typeof objects.Invoice, typeof consumer.objects.Invoice>
  > = true;

  void sameReads;
  await objects.Invoice.query();
  await objects.Invoice.query({ select: ['id'], limit: 100 });
  await objects.Invoice.query({
    where: { status: 'open' },
    select: ['id'],
    limit: 100,
  });
  await objects.Invoice.query({
    // @ts-expect-error filter value must match field schema
    where: { status: 42 },
    select: ['id'],
  });
  await objects.Invoice.query({
    // @ts-expect-error unknown filter property
    where: { missing: 'x' },
    select: ['id'],
  });

  for await (const invoice of objects.Invoice.query({ select: ['id'] })) {
    const selected: Expect<
      Equal<typeof invoice.data, { readonly id?: string }>
    > = true;

    void selected;
    // @ts-expect-error iteration preserves selection
    invoice.data.status;
  }

  for await (const invoice of objects.Customer.traverse.invoices('c', {
    select: ['status'],
  })) {
    const selected: Expect<
      Equal<typeof invoice.data, { readonly status?: string }>
    > = true;

    void selected;
    // @ts-expect-error traversal iteration preserves target selection
    invoice.data.totalMinor;
  }

  // @ts-expect-error to-one traversal remains a promise, not an iterable
  for await (const customer of objects.Invoice.traverse.customer('i'))
    void customer;

  const invoices = await objects.Customer.traverse.invoices('c', {
    select: ['status'],
    limit: 100,
    cursor: 'next',
  });
  const many: Expect<
    Equal<(typeof invoices.data)[number]['data'], { readonly status?: string }>
  > = true;
  const customer = await objects.Invoice.traverse.customer('i', {
    select: ['name'],
  });
  const one: Expect<Equal<typeof customer.status, 'ok' | 'not-found'>> = true;

  void many;
  void one;

  if (customer.status === 'ok') {
    const selection: Expect<
      Equal<typeof customer.data, { readonly name?: string }>
    > = true;

    void selection;
    // @ts-expect-error unselected target property
    customer.data.revenue;
  }

  // @ts-expect-error single relationship has no pagination
  await objects.Invoice.traverse.customer('i', { limit: 10 });
  // @ts-expect-error selection belongs to the target object
  await objects.Customer.traverse.invoices('c', { select: ['name'] });
  // @ts-expect-error unknown traversal
  objects.Customer.traverse.tasks('c');
  // @ts-expect-error query replaces list in actions too
  objects.Invoice.list();
  // @ts-expect-error only runtime owns commit
  objects.commit();

  return { reviewId: 'r', taskIds: [] };
});

const implementations = [
  addAccountReview,
  escalateAccount,
  reviewInvoice,
] as const;

createRuntime({
  graph,
  actionImplementations: implementations,
  connections: [],
});
createRuntime({
  graph: { ...graph, actions: { review: AddAccountReview } },
  actionImplementations: [addAccountReview],
  connections: [],
});
createRuntime({
  graph,
  connections: [],
  // @ts-expect-error missing action implementation
  actionImplementations: [addAccountReview],
});
createRuntime({
  graph,
  connections: [],
  // @ts-expect-error duplicate implementation
  actionImplementations: [...implementations, addAccountReview],
});
const dynamic = [addAccountReview, escalateAccount, reviewInvoice];

createRuntime({
  graph,
  connections: [],
  // @ts-expect-error widened arrays cannot prove coverage
  actionImplementations: dynamic,
});
const foreign = implementAction(
  { ...AddAccountReview, id: 'foreign' as const },
  async () => ({ reviewId: 'r' }),
);

createRuntime({
  graph,
  connections: [],
  // @ts-expect-error foreign action ID
  actionImplementations: [foreign, escalateAccount, reviewInvoice],
});
const mismatch = implementAction(
  { ...EscalateAccount, id: AddAccountReview.id },
  async () => ({ reviewId: 'r', taskIds: [] }),
);

createRuntime({
  graph,
  connections: [],
  // @ts-expect-error same ID does not excuse a different input/output contract
  actionImplementations: [mismatch, escalateAccount, reviewInvoice],
});
// A targetless action with scalar inputs needs neither reads nor effects.
const Echo = defineAction({
  id: 'echo',
  input: z.object({ text: z.string() }),
  output: z.string(),
  creates: [],
  policy: { execute: access.role('employee') },
});

implementAction(Echo, async ({ input }) => input.text);
createRuntime({
  graph: { ...graph, actions: {} },
  actionImplementations: [],
  connections: [],
});
// Vocabulary mismatch and missing object registry must not install successfully.
const differentBinder = createActionImplementer({
  access,
  objects: { ...objects, Other: Customer },
  relationships,
});
const differentObjects = differentBinder(AddAccountReview, async () => ({
  reviewId: 'r',
}));

createRuntime({
  graph,
  connections: [],
  // @ts-expect-error graph cannot supply an implementation's extra object binding
  actionImplementations: [differentObjects, escalateAccount, reviewInvoice],
});
createActionImplementer({
  access,
  objects: { Customer },
  // @ts-expect-error relationship endpoint Invoice is not in the object registry
  relationships: { CustomerInvoices },
});
const differentRelationshipBinder = createActionImplementer({
  access,
  objects,
  relationships: {
    ...relationships,
    Other: {
      ...CustomerInvoices,
      id: 'other-customer-invoices',
      forward: { name: 'otherInvoices', cardinality: 'many' },
    },
  },
});
const differentRelationships = differentRelationshipBinder(
  AddAccountReview,
  async () => ({
    reviewId: 'r',
  }),
);

createRuntime({
  graph,
  connections: [],
  actionImplementations: [
    // @ts-expect-error graph cannot supply an implementation's extra relationship binding
    differentRelationships,
    escalateAccount,
    reviewInvoice,
  ],
});
defineGraph({
  ...graph,
  objects: { Customer },
  relationships: {},
  // @ts-expect-error created object must be registered
  actions: { addAccountReview: AddAccountReview },
});

// Existing authorization and model boundaries remain part of this fixture.
const runtime = createFixtureApp();

runtime.as({
  id: 'eve',
  roles: ['employee'],
  // @ts-expect-error principal requires portfolio claim
  claims: {},
});
// @ts-expect-error consumer has no host adoption surface
consumer.host;
// @ts-expect-error only source-owned objects can be adopted
void runtime.host.adopt(AccountReview, 'r');
defineAction({
  ...AddAccountReview,
  policy: {
    // @ts-expect-error unknown role in this vocabulary
    execute: access.role('administrator'),
  },
});
defineRelationship({
  ...CustomerInvoices,
  // @ts-expect-error via must be a reference to the proper object
  via: Invoice.properties.status,
});
connect(crmCustomers, {
  connectionId: 'crm',
  connector: {
    // @ts-expect-error provider records must follow the source schema
    async fetch() {
      return { state: 'present' as const, record: { id: 'c' } };
    },
  },
});
const incompatible = defineAccess({
  roles: ['employee'],
  fieldGroups: ['ordinary'],
  claims: { tenant: z.number() },
});

createRuntime({
  graph: { ...graph, access: incompatible },
  connections: [],
  // @ts-expect-error graph access cannot supply implementation claims
  actionImplementations: implementations,
});
