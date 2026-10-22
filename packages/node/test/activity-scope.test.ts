import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { bind, implementAction } from 'relate';
import { createRuntime } from '@relate/node';
import { createMemoryStore } from '@relate/runtime';
import {
  AddAccountReview,
  Customer,
  addAccountReview,
  ana,
  customers,
  graph,
  invoices,
} from '../../../tests/support/native-action-model.js';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });

  return { promise, resolve };
}

function bindings(name: () => Promise<string>) {
  return [
    bind(customers, {
      connectionId: 'crm',
      resourceId: 'records',
      connector: {
        identity: 'application',
        async fetch(id) {
          return {
            state: 'present',
            record: { id, name: await name(), portfolio: 'north' },
          };
        },
      },
    }),
    bind(invoices, {
      connectionId: 'billing',
      resourceId: 'records',
      connector: {
        identity: 'application',
        fetch: async (id) => ({ state: 'present', record: { id } }),
      },
    }),
  ];
}

it('keeps concurrent read and query refreshes attached to their own runtime and request', async (test) => {
  const calls = await Promise.all(
    ['get', 'query'].map(async (method) => {
      const entered = deferred();
      const release = deferred();
      const store = createMemoryStore();
      const graphId = randomUUID();
      let refreshing = false;
      const runtime = createRuntime({
        graph,
        graphId,
        store,
        actionImplementations: [addAccountReview],
        bindings: bindings(async () => {
          if (!refreshing) return 'Before';

          entered.resolve();
          await release.promise;

          return 'After';
        }),
      });

      test.onTestFinished(async () => {
        release.resolve();
        await runtime.close();
      });
      const customer = await runtime.host.adopt(Customer, method);
      const principal = { ...ana, id: method };
      const context = { requestId: method, transport: 'http' as const };
      const operations = runtime.operations(principal, context);

      refreshing = true;
      const pending =
        method === 'get'
          ? operations.get(Customer.id, customer, { refresh: true })
          : operations.query(Customer.id, { refresh: true });

      return {
        method,
        entered,
        release,
        store,
        graphId,
        runtime,
        context,
        pending,
      };
    }),
  );

  await Promise.all(calls.map((call) => call.entered.promise));

  // Finish in reverse order, while the other request remains suspended.
  for (const call of [...calls].reverse()) {
    call.release.resolve();
    await call.pending;
    await call.runtime.close();
    const operations = (
      await call.store.activity!.operations.list(call.graphId)
    ).entries;
    const parent = operations.find((row) => row.kind === call.method)!;
    const refresh = operations.find((row) => row.kind === 'refresh')!;

    expect(parent).toMatchObject({
      actor: { kind: 'principal', id: call.method },
      context: call.context,
    });
    expect(refresh).toMatchObject({
      parentOperationId: parent.id,
      actor: parent.actor,
      context: call.context,
      details: { refresh: 'changed' },
    });
    expect(
      (await call.store.activity!.feed.read(call.graphId)).entries,
    ).toEqual([
      expect.objectContaining({ kind: 'adopted' }),
      expect.objectContaining({
        kind: 'updated',
        operationId: refresh.id,
        parentOperationId: parent.id,
        triggeredBy: parent.actor,
        context: call.context,
      }),
    ]);
  }
});

it('keeps action queries in the outer scope after a nested public call with another principal', async (test) => {
  const store = createMemoryStore();
  const graphId = randomUUID();
  let fetches = 0;
  // Assigned after construction, before the handler can run.
  let nestedRead!: (customer: string) => Promise<unknown>;
  const runtime = createRuntime({
    graph,
    graphId,
    store,
    bindings: bindings(async () => `Name ${++fetches}`),
    actionImplementations: [
      implementAction(graph, AddAccountReview, async (context) => {
        await nestedRead(context.input.customer);
        await context.objects.Customer.query({ refresh: true });

        return addAccountReview.implementation(context);
      }),
    ],
  });

  test.onTestFinished(() => runtime.close());
  const customer = await runtime.host.adopt(Customer, 'one');

  nestedRead = (id) =>
    runtime
      .operations(
        { ...ana, id: 'ben' },
        {
          requestId: 'inner',
          transport: 'http',
        },
      )
      .get(Customer.id, id, { refresh: true });
  const receipt = await runtime
    .operations(ana, {
      requestId: 'outer',
      transport: 'mcp',
    })
    .invoke(AddAccountReview.id, {
      input: { customer, note: 'Nested reads' },
      idempotencyKey: 'one',
    });

  await runtime.close();
  const operations = (await store.activity!.operations.list(graphId)).entries;
  const invoke = operations.find((row) => row.kind === 'invoke')!;
  const get = operations.find((row) => row.kind === 'get')!;
  const refreshes = operations.filter((row) => row.kind === 'refresh');

  expect(invoke).toMatchObject({
    invocationId: receipt.invocationId,
    replayed: false,
  });
  expect(refreshes).toHaveLength(2);

  for (const parent of [invoke, get]) {
    expect(refreshes).toContainEqual(
      expect.objectContaining({
        parentOperationId: parent.id,
        actor: parent.actor,
        context: parent.context,
      }),
    );
  }

  expect(operations.filter((row) => row.kind === 'query')).toHaveLength(0);
  const feed = (await store.activity!.feed.read(graphId)).entries;

  expect(
    feed
      .filter((row) => row.kind === 'updated')
      .map((row) => row.context.requestId),
  ).toEqual(['inner', 'outer']);
  expect(feed.find((row) => row.kind === 'created')).toMatchObject({
    operationId: invoke.id,
    actor: { kind: 'principal', id: ana.id },
    context: invoke.context,
  });
});

it('rejects late handler reads after timeout without attributing them to the next attempt', async (test) => {
  const store = createMemoryStore();
  const graphId = randomUUID();
  const entered = deferred();
  const release = deferred();
  const resumed = deferred();
  let lateError: unknown;
  const runtime = createRuntime({
    graph,
    graphId,
    store,
    actionTimeoutMs: 500,
    bindings: bindings(async () => 'Customer'),
    actionImplementations: [
      implementAction(graph, AddAccountReview, async (context) => {
        if (context.input.note === 'slow') {
          entered.resolve();
          await release.promise;

          try {
            await context.objects.Customer.query({ refresh: true });
          } catch (error) {
            lateError = error;
          } finally {
            resumed.resolve();
          }
        }

        return addAccountReview.implementation(context);
      }),
    ],
  });

  test.onTestFinished(async () => {
    release.resolve();
    await runtime.close();
  });
  const customer = await runtime.host.adopt(Customer, 'one');
  const expired = expect(
    runtime
      .operations(ana, { requestId: 'expired' })
      .invoke(AddAccountReview.id, {
        input: { customer, note: 'slow' },
        idempotencyKey: 'same-key',
      }),
  ).rejects.toMatchObject({ code: 'unavailable' });

  await entered.promise;
  await expired;
  const receipt = await runtime
    .operations(ana, { requestId: 'next' })
    .invoke(AddAccountReview.id, {
      input: { customer, note: 'fast' },
      idempotencyKey: 'same-key',
    });

  release.resolve();
  await resumed.promise;
  await runtime.close();

  expect(lateError).toMatchObject({ code: 'unavailable' });
  const operations = (await store.activity!.operations.list(graphId)).entries;

  expect(operations.filter((row) => row.kind === 'refresh')).toHaveLength(0);
  expect(operations.filter((row) => row.kind === 'invoke')).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        context: expect.objectContaining({ requestId: 'expired' }),
        outcome: { status: 'rejected', code: 'unavailable' },
      }),
      expect.objectContaining({
        context: expect.objectContaining({ requestId: 'next' }),
        invocationId: receipt.invocationId,
        replayed: false,
      }),
    ]),
  );
  const committed = (await store.activity!.feed.read(graphId)).entries.filter(
    (row) => row.kind !== 'adopted',
  );

  expect(committed.map((row) => row.kind)).toEqual([
    'created',
    'invocation-succeeded',
  ]);
  expect(committed.every((row) => row.context.requestId === 'next')).toBe(true);
});
