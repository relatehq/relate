import { expect, it } from 'vitest';
import { createRuntime } from '@relate/node';
import { createMemoryStore } from '@relate/runtime';
import { connect, implementAction } from 'relate';
import {
  graph,
  customers,
  invoices,
  Customer,
  AccountReview,
  AddAccountReview,
  addAccountReview,
  ana,
} from '../../../tests/support/native-action-model.js';

function setup(
  options: {
    enabled?: boolean;
    failFeed?: boolean;
    failOperations?: boolean;
  } = {},
) {
  const store = createMemoryStore();
  let name = 'Mothlight',
    now = 1000;
  const native = store.native!;
  const runtime = createRuntime({
    graph,
    graphId: 'activity-app',
    clock: () => now,
    activity: { enabled: options.enabled ?? true },
    store: {
      ...store,
      activity: {
        ...store.activity!,
        appendOperations: options.failOperations
          ? async () => {
              throw new Error('SECRET');
            }
          : store.activity!.appendOperations,
      },
      native: {
        ...native,
        transaction: (scope, callback) =>
          native.transaction(scope, (tx) =>
            callback({
              ...tx,
              appendFeed: options.failFeed
                ? async () => {
                    throw new Error('feed failure');
                  }
                : tx.appendFeed!,
            }),
          ),
      },
    },
    actionImplementations: [addAccountReview],
    connections: [
      connect(customers, {
        connectionId: 'crm',
        connector: {
          identity: 'application',
          async fetch(id) {
            return {
              state: 'present',
              record: { id, name, portfolio: 'north' },
            };
          },
        },
      }),
      connect(invoices, {
        connectionId: 'billing',
        connector: {
          identity: 'application',
          async fetch(id) {
            return { state: 'present', record: { id } };
          },
        },
      }),
    ],
  });

  return {
    runtime,
    store,
    rename: () => {
      name = 'SECRET new name';
      now += 100000;
    },
  };
}

it('records creation, completion, retry, provenance and source refresh through the public API', async () => {
  const { runtime, store, rename } = setup();
  const customer = await runtime.host.adopt(Customer, 'mothlight');
  const actor = runtime.as(ana);
  const receipt = await actor.actions.addAccountReview({
    input: { customer, note: 'SECRET note' },
    idempotencyKey: 'one',
  });

  expect(receipt.state).toBe('succeeded');
  expect(
    await actor.actions.addAccountReview({
      input: { customer, note: 'SECRET note' },
      idempotencyKey: 'one',
    }),
  ).toEqual(receipt);
  rename();
  await actor.objects.Customer.get(customer, {
    select: ['name'],
    evidence: 'compact',
  });
  await runtime.close();
  const feed = await store.activity!.feed.read('activity-app');

  expect(feed.entries.map((r) => r.kind)).toEqual([
    'adopted',
    'created',
    'invocation-succeeded',
    'updated',
  ]);
  const creation = feed.entries[1]!;

  expect(creation.invocationId).toBe(receipt.invocationId);

  if (!('object' in creation)) throw new Error('expected creation');

  expect(
    await store.native!.provenance(
      {
        graphId: 'activity-app',
        definitionRevision: creation.definitionRevision,
      },
      creation.object,
    ),
  ).toMatchObject({
    kind: 'created',
    actor: { kind: 'principal', id: ana.id },
    invocationId: receipt.invocationId,
  });
  const operations = (await store.activity!.operations.list('activity-app'))
    .entries;

  expect(
    operations
      .filter((r) => r.kind === 'invoke')
      .map((r) => r.replayed)
      .sort(),
  ).toEqual([false, true]);
  const refresh = operations.find((r) => r.kind === 'refresh')!;

  expect(refresh).toMatchObject({ details: { refresh: 'changed' } });
  expect(feed.entries[3]).toMatchObject({
    operationId: refresh.id,
    parentOperationId: refresh.parentOperationId,
    actor: { kind: 'source', id: customers.id },
    triggeredBy: { kind: 'principal', id: ana.id },
  });
  expect(feed.entries[3]!.invocationId).toBeUndefined();
  expect(JSON.stringify({ feed, operations })).not.toContain('SECRET');
  expect(operations.find((r) => r.kind === 'get')).toMatchObject({
    objects: expect.arrayContaining([
      expect.objectContaining({ returned: ['customer.name'] }),
    ]),
  });
});
it('uses fresh IDs for reusable embedded bindings and preserves explicit transport context', async () => {
  const { runtime, store } = setup();
  const customer = await runtime.host.adopt(Customer, 'mothlight');
  const actor = runtime.as(ana);

  await actor.objects.Customer.get(customer);
  await actor.objects.Customer.get(customer);
  const ops = runtime.operations(ana, {
    requestId: 'http-request',
    transport: 'http',
  });

  await ops.get(Customer.id, customer);
  await ops.get(Customer.id, customer);
  await runtime.close();
  const rows = (
    await store.activity!.operations.list('activity-app')
  ).entries.filter((r) => r.kind === 'get');

  expect(new Set(rows.map((r) => r.id)).size).toBe(4);
  expect(
    rows.filter((r) => r.context.requestId === 'http-request'),
  ).toHaveLength(2);
  expect(
    new Set(
      rows
        .filter((r) => r.context.transport === 'embedded')
        .map((r) => r.context.requestId),
    ).size,
  ).toBe(2);
});
it('operation capture loss and disabling it preserve feed and permanent provenance', async () => {
  for (const config of [{ enabled: false }, { failOperations: true }]) {
    const { runtime, store } = setup(config);
    const customer = await runtime.host.adopt(Customer, 'mothlight');

    expect(
      await runtime.host.provenance({
        objectDefinitionId: Customer.id,
        objectId: customer,
      }),
    ).toMatchObject({ kind: 'adopted' });
    await runtime.as(ana).actions.addAccountReview({
      input: { customer, note: 'note' },
      idempotencyKey: 'one',
    });
    await runtime.close();
    expect(
      (await store.activity!.feed.read('activity-app')).entries,
    ).toHaveLength(3);
    expect(
      (await store.activity!.operations.list('activity-app')).entries,
    ).toEqual([]);
  }
});
it('a failed required feed append rolls back the native object and receipt', async () => {
  const { runtime, store } = setup({ failFeed: true });
  const customer = await runtime.host.adopt(Customer, 'mothlight');

  await expect(
    runtime.as(ana).actions.addAccountReview({
      input: { customer, note: 'note' },
      idempotencyKey: 'one',
    }),
  ).rejects.toMatchObject({ code: 'internal' });
  await runtime.close();
  const adoption = (await store.activity!.feed.read('activity-app'))
    .entries[0]!;
  const scope = {
    graphId: 'activity-app',
    definitionRevision: adoption.definitionRevision,
  };

  expect(
    (await store.native!.scan(scope, AccountReview.id, { limit: 100 })).objects,
  ).toEqual([]);
  expect(
    await store.native!.loadInvocation(scope, AddAccountReview.id, 'one'),
  ).toBeUndefined();
  expect(
    (await store.activity!.feed.read('activity-app')).entries.map(
      (r) => r.kind,
    ),
  ).toEqual(['adopted']);
  expect(
    (await store.activity!.operations.list('activity-app')).entries.find(
      (r) => r.kind === 'invoke',
    ),
  ).toMatchObject({ outcome: { status: 'rejected' }, replayed: false });
});

import {
  domainGraph,
  Review,
} from '../../../tests/support/domain-action-contract.js';
import { NativeCommitUncertain } from '@relate/runtime/storage';

it('domain failure rolls back creation and commits only its failed invocation event', async () => {
  const store = createMemoryStore();
  const runtime = createRuntime({
    graph: domainGraph,
    store,
    connections: [
      connect(customers, {
        connectionId: 'crm',
        connector: {
          identity: 'application',
          fetch: async (id) => ({
            state: 'present',
            record: { id, name: 'Mothlight', portfolio: 'north' },
          }),
        },
      }),
    ],
    actionImplementations: [
      implementAction(
        domainGraph,
        Review,
        async ({ input, actor, objects, fail }) => {
          await objects.AccountReview.create({
            customer: input.customer,
            note: input.note,
            author: actor.id,
          });

          return fail('inactive', {});
        },
      ),
    ],
  });
  const customer = await runtime.host.adopt(Customer, '1');
  const receipt = await runtime.as(ana).actions.review({
    input: { customer, note: 'private' },
    idempotencyKey: 'failed',
  });

  expect(receipt.state).toBe('failed');
  await runtime.close();
  const feed = (await store.activity!.feed.read(domainGraph.id)).entries;

  expect(feed.map((e) => e.kind)).toEqual(['adopted', 'invocation-failed']);
  expect(feed[1]).toMatchObject({
    failureCode: 'inactive',
    invocationId: receipt.invocationId,
  });
});
it('a lost commit acknowledgement records uncertainty while preserving committed feed entries', async () => {
  const store = createMemoryStore(),
    native = store.native!;
  const runtime = createRuntime({
    graph: domainGraph,
    store: {
      ...store,
      native: {
        ...native,
        async transaction(scope, callback) {
          await native.transaction(scope, callback);
          throw new NativeCommitUncertain();
        },
      },
    },
    connections: [
      connect(customers, {
        connectionId: 'crm',
        connector: {
          identity: 'application',
          fetch: async (id) => ({
            state: 'present',
            record: { id, name: 'Mothlight', portfolio: 'north' },
          }),
        },
      }),
    ],
    actionImplementations: [
      implementAction(domainGraph, Review, async ({ fail }) =>
        fail('inactive', {}),
      ),
    ],
  });
  const customer = await runtime.host.adopt(Customer, '1');

  await expect(
    runtime.as(ana).actions.review({
      input: { customer, note: 'private' },
      idempotencyKey: 'uncertain',
    }),
  ).rejects.toMatchObject({ code: 'uncertain' });
  await runtime.close();
  expect(
    (await store.activity!.feed.read(domainGraph.id)).entries.map(
      (e) => e.kind,
    ),
  ).toEqual(['adopted', 'invocation-failed']);
  const operation = (
    await store.activity!.operations.list(domainGraph.id)
  ).entries.find((o) => o.kind === 'invoke')!;

  expect(operation.outcome).toEqual({ status: 'uncertain' });
  expect(operation).not.toHaveProperty('invocationId');
});
it('provenance remains available when activity is unsupported', async () => {
  const store = createMemoryStore();
  const { activity: _activity, ...unsupported } = store;
  const runtime = createRuntime({
    graph: domainGraph,
    store: unsupported,
    connections: [
      connect(customers, {
        connectionId: 'crm',
        connector: {
          identity: 'application',
          fetch: async (id) => ({
            state: 'present',
            record: { id, name: 'Mothlight', portfolio: 'north' },
          }),
        },
      }),
    ],
    actionImplementations: [
      implementAction(domainGraph, Review, async ({ fail }) =>
        fail('inactive', {}),
      ),
    ],
  });
  const customer = await runtime.host.adopt(Customer, '1');

  expect(await runtime.host.activity.status()).toEqual({
    state: 'unsupported',
  });
  await expect(runtime.host.activity.feed.read()).rejects.toMatchObject({
    code: 'unsupported',
  });
  expect(
    await runtime.host.provenance({
      objectDefinitionId: Customer.id,
      objectId: customer,
    }),
  ).toMatchObject({ kind: 'adopted' });
  expect(
    await runtime.host.provenance({
      objectDefinitionId: Customer.id,
      objectId: 'missing',
    }),
  ).toBeUndefined();
  await runtime.close();
});
