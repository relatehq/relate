/**
 * Mistakes the types must catch. Each `@ts-expect-error` fails the typecheck
 * if the line beneath it starts compiling.
 */
import { z } from 'zod';
import type { ObjectRecord } from './target.js';
import {
  connect,
  defineAction,
  defineAccess,
  defineGraph,
  createRuntime,
  defineObject,
  defineRelationship,
  objectId,
  source,
} from './target.js';
import { access } from '../source/access.js';
import { ana, createFixtureApp } from './setup.js';
import { graph } from '../source/graph.js';
import {
  AccountReview,
  crmCustomers,
  Customer,
  CustomerInvoices,
  Invoice,
} from '../source/model.js';
import { Task } from '../source/model.js';
import { AddAccountReview } from '../source/actions/add-account-review.js';
import { EscalateAccount } from '../source/actions/escalate-account.js';
import { implementAction } from '../source/actions/implement-action.server.js';
import { addAccountReview } from '../source/actions/add-account-review.server.js';
import { escalateAccount } from '../source/actions/escalate-account.server.js';

type Expect<T extends true> = T;

type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
    ? true
    : false;

const relate = createFixtureApp();
const consumer = relate.as(ana);

// Reads

export async function reads(id: string) {
  const customer = await consumer.objects.Customer.get(id, {
    select: ['name', 'revenue'],
  });

  if (customer.status !== 'ok') return;

  type Selected = Expect<
    Equal<
      typeof customer.data,
      { readonly name?: string; readonly revenue?: number }
    >
  >;

  // @ts-expect-error organization was not selected
  customer.data.organization;
  // @ts-expect-error evidence is keyed by the selection too
  customer.meta.fields.organization;

  const whole = await consumer.objects.Customer.get(id);

  if (whole.status !== 'ok') return;

  type Everything = Expect<
    Equal<keyof typeof whole.data, 'id' | 'name' | 'organization' | 'revenue'>
  >;

  // @ts-expect-error unknown property
  await consumer.objects.Customer.get(id, { select: ['nmae'] });
  // @ts-expect-error unknown object
  consumer.objects.Account;

  const invoices = await consumer.objects.Customer.traverse.invoices(id, {
    select: ['totalMinor'],
  });

  type Many = Expect<
    Equal<
      (typeof invoices.data)[number]['data'],
      { readonly totalMinor?: number }
    >
  >;

  const owner = await consumer.objects.Invoice.traverse.customer(id);

  type One = Expect<Equal<(typeof owner)['status'], 'not-found' | 'ok'>>;

  // @ts-expect-error selection is checked against the traversal's target
  await consumer.objects.Customer.traverse.invoices(id, { select: ['name'] });
  // @ts-expect-error reviews do not have invoices
  consumer.objects.AccountReview.traverse.invoices;
  // @ts-expect-error a single related object is not paginated
  await consumer.objects.Invoice.traverse.customer(id, { limit: 10 });

  return [] as unknown as [Selected, Everything, Many, One];
}

// Actions

export async function actions(id: string) {
  const receipt = await consumer.actions.addAccountReview({
    target: id,
    input: { note: 'ok' },
    idempotencyKey: 'k',
  });

  // @ts-expect-error output exists only once the outcome is known to be success
  receipt.output;

  await consumer.actions.addAccountReview({
    target: id,
    // @ts-expect-error input follows the action's schema
    input: { note: 1 },
    idempotencyKey: 'k',
  });
  // @ts-expect-error every invocation carries an idempotency key
  await consumer.actions.addAccountReview({ target: id, input: { note: '' } });
  // @ts-expect-error unknown action
  consumer.actions.deleteCustomer;
}

// A graph with one action keeps the implementation cases to one entry each.
const single = defineGraph({
  id: 'single.graph',
  objects: { Customer, AccountReview },
  relationships: {},
  actions: { addAccountReview: AddAccountReview },
  access,
  policies: [],
});

defineAction({
  id: 'bad.reads',
  target: AccountReview,
  input: z.object({}),
  output: z.object({}),
  creates: [],
  // @ts-expect-error reads must start at the action's target
  reads: { invoices: CustomerInvoices },
});

defineAction({
  id: 'bad.creates-sourced',
  target: Customer,
  input: z.object({}),
  output: z.object({}),
  // @ts-expect-error a source owns invoices; an action cannot create them
  creates: [Invoice],
});

// Action policies belong to the shared action definition.

defineAction({
  ...AddAccountReview,
  policy: {
    // @ts-expect-error the role must come from the shared access vocabulary
    execute: access.role('administrator'),
  },
});

defineAction({
  ...AddAccountReview,
  policy: {
    // @ts-expect-error shared policies are declarative, not server callbacks
    execute: () => true,
  },
});

// Omitting policy is valid authoring; runtime must deny discovery/execution.
defineAction({
  id: 'business.unavailable-review',
  target: Customer,
  input: AddAccountReview.input,
  output: AddAccountReview.output,
  creates: [AccountReview],
});

// @ts-expect-error policies are no longer attached through access.actionPolicy
access.actionPolicy(AddAccountReview, {
  execute: access.role('account-manager'),
});

defineGraph({
  ...graph,
  policies: [
    // @ts-expect-error graph-level policies are object policies, not action overrides
    { execute: access.role('account-manager') },
  ],
});

// Principals and trusted operations

relate.as({
  id: 'eve',
  // @ts-expect-error roles come from the access declaration
  roles: ['admin'],
  claims: { organization: 'org_north' },
});
// @ts-expect-error claims come from the access declaration
relate.as({ id: 'eve', roles: ['employee'], claims: {} });
// @ts-expect-error reads need a principal
relate.objects;
// @ts-expect-error consumers cannot adopt
consumer.host;
// @ts-expect-error only source-owned objects are adopted
void relate.host.adopt(AccountReview, 'review_1');

// Definitions

defineRelationship({
  id: 'bad.via',
  from: Customer,
  to: Invoice,
  forward: { name: 'invoices', cardinality: 'many' },
  reverse: { name: 'customer', cardinality: 'one' },
  // @ts-expect-error `via` must be a reference on `to` that targets `from`
  via: Invoice.properties.status,
});

defineRelationship({
  id: 'bad.direction',
  from: Invoice,
  to: Customer,
  forward: { name: 'customer', cardinality: 'one' },
  reverse: { name: 'invoices', cardinality: 'many' },
  // @ts-expect-error the reference lives on Invoice, which is `from` here
  via: Invoice.properties.customer,
});

const Unregistered = defineObject({
  id: 'business.unregistered',
  name: 'Unregistered',
  membership: source(crmCustomers),
  properties: {
    id: objectId({
      id: 'business.unregistered.key',
      access: access.groups.ordinary,
    }),
  },
});

defineGraph({
  id: 'bad.graph',
  objects: { Customer, Unregistered },
  // @ts-expect-error both endpoints must be registered objects
  relationships: { CustomerInvoices },
  actions: {},
  access,
  policies: [],
});

defineGraph({
  id: 'bad.action-graph',
  objects: { Customer },
  relationships: {},
  // @ts-expect-error the action creates an object this graph does not register
  actions: { addAccountReview: AddAccountReview },
  access,
  policies: [],
});

connect(crmCustomers, {
  connectionId: 'crm',
  connector: {
    // @ts-expect-error the connector must return records matching the source
    async fetch() {
      return { state: 'present' as const, record: { id: 'crm_1' } };
    },
  },
});

// Action-bound builder plans and inferred context.

implementAction(
  AddAccountReview,
  ({ actor, target, input, reads, changes }) => {
    const organization: string = actor.claims.organization;
    const note: string = input.note;

    void organization;
    void note;
    // @ts-expect-error unknown claim
    actor.claims.tenant;
    // @ts-expect-error input follows the bound action
    input.assignee;
    // @ts-expect-error no reads declared for this action
    reads.invoices;
    // @ts-expect-error undeclared native type
    changes.create(Task, {
      customer: 'c',
      review: 'r',
      invoice: 'i',
      assignee: 'sam',
      dueDate: 'date',
    });
    // @ts-expect-error source-owned records cannot be created natively
    changes.create(Invoice, {});
    // @ts-expect-error every native property is required
    changes.create(AccountReview, { customer: target.id });
    changes.create(AccountReview, {
      customer: target.id,
      author: actor.id,
      note: input.note,
      // @ts-expect-error IDs are allocated by the builder
      id: 'mine',
    });
    // @ts-expect-error output follows the bound action
    changes.build({ reviewId: 42 });

    return changes.build({ reviewId: 'r' });
  },
);

implementAction(EscalateAccount, ({ reads, changes }) => {
  type DeclaredReads = Expect<
    Equal<
      typeof reads,
      { readonly invoices: readonly ObjectRecord<typeof Invoice>[] }
    >
  >;

  const checked: DeclaredReads = true;

  void checked;
  // @ts-expect-error only declared reads are available
  reads.reviews;
  // @ts-expect-error builder does not execute commits
  changes.commit();

  return changes.build({ reviewId: 'r', taskIds: [] });
});

// @ts-expect-error implementation must return a sealed plan
implementAction(AddAccountReview, () => ({ reviewId: 'r' }));
implementAction(
  AddAccountReview,
  // @ts-expect-error planning is synchronous
  async ({ changes }) => changes.build({ reviewId: 'r' }),
);

// Literal IDs survive defineAction without annotations.
const actionId: 'business.add-account-review' = AddAccountReview.id;

void actionId;
// Direct runtime assembly retains inference without an intermediate registry.
const singleRuntime = createRuntime({
  graph: single,
  actionImplementations: [addAccountReview],
  connections: [],
});
const fullRuntime = createRuntime({
  graph,
  actionImplementations: [addAccountReview, escalateAccount],
  connections: [],
});
const featureImplementations = [addAccountReview, escalateAccount] as const;

createRuntime({
  graph,
  actionImplementations: [...featureImplementations],
  connections: [],
});
const renamedRuntime = createRuntime({
  graph: {
    ...graph,
    actions: { review: AddAccountReview, escalate: EscalateAccount },
  },
  actionImplementations: featureImplementations,
  connections: [],
});

// Positive calls retain graph-specific consumers and schemas.
void fullRuntime.as(ana).actions.escalateAccount({
  target: 'c',
  input: { note: 'n', assignee: 'sam', dueDate: 'date' },
  idempotencyKey: 'k',
});
void renamedRuntime
  .as(ana)
  .actions.review({ target: 'c', input: { note: 'n' }, idempotencyKey: 'k' });
// @ts-expect-error the single-action graph does not acquire other actions
singleRuntime.as(ana).actions.escalateAccount;
// @ts-expect-error consumer names still come from the graph, not implementation exports
renamedRuntime.as(ana).actions.addAccountReview;

createRuntime({
  graph: single,
  connections: [],
  // @ts-expect-error every action needs an implementation
  actionImplementations: [],
});
createRuntime({
  graph,
  connections: [],
  // @ts-expect-error missing escalation implementation
  actionImplementations: [addAccountReview],
});
createRuntime({
  graph,
  connections: [],
  // @ts-expect-error duplicate action ID even when coverage is complete
  actionImplementations: [addAccountReview, escalateAccount, addAccountReview],
});
const foreign = implementAction(
  { ...AddAccountReview, id: 'business.foreign' as const },
  ({ changes }) => changes.build({ reviewId: 'r' }),
);

createRuntime({
  graph,
  connections: [],
  // @ts-expect-error identical schema does not permit an unregistered action ID
  actionImplementations: [foreign, escalateAccount],
});
const mismatched = implementAction(
  { ...EscalateAccount, id: AddAccountReview.id },
  ({ changes }) => changes.build({ reviewId: 'r', taskIds: [] }),
);

createRuntime({
  graph,
  connections: [],
  // @ts-expect-error matching ID does not permit a different contract
  actionImplementations: [mismatched, escalateAccount],
});
const dynamicImplementations = [addAccountReview, escalateAccount];

createRuntime({
  graph,
  connections: [],
  // @ts-expect-error widened arrays cannot establish coverage and uniqueness
  actionImplementations: dynamicImplementations,
});
const incompatibleAccess = defineAccess({
  roles: ['employee'],
  fieldGroups: ['ordinary'],
  claims: { tenant: z.number() },
});

createRuntime({
  graph: { ...graph, access: incompatibleAccess },
  connections: [],
  // @ts-expect-error the graph cannot supply the implementation's access vocabulary
  actionImplementations: featureImplementations,
});
createRuntime({
  graph: single,
  connections: [],
  actionImplementations: {
    // @ts-expect-error registration takes a tuple of action-bound implementations
    addAccountReview: addAccountReview.implementation,
  },
});
// A graph without actions needs no implementations.
createRuntime({
  graph: { ...graph, actions: {} },
  actionImplementations: [],
  connections: [],
});
