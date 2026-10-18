import { randomUUID } from 'node:crypto';
import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { connect, implementAction } from 'relate';
import { createRuntime } from '@relate/node';
import { createMemoryStore } from '@relate/runtime';
import { NativeCommitUncertain } from '@relate/runtime/storage';
import type { ObservationStore } from '@relate/runtime/storage';
import type { Change, Operation } from '@relate/protocol';
import { createInvoiceGraph } from '../../../tests/support/invoice-graph.js';
import {
  AccountReview,
  AddAccountReview,
  Customer,
  addAccountReview,
  ana,
  customers,
  graph,
  invoices,
} from '../../../tests/support/native-action-model.js';

function reviewConnections(
  crm: { name?: () => string; portfolio?: () => string } = {},
) {
  return [
    connect(customers, {
      providerAccountId: 'example-account',
      connectionId: 'crm',
      connector: {
        identify: async () => 'example-account',
        fetch: async (id) => ({
          providerAccountId: 'example-account',
          state: 'present',
          record: {
            id,
            name: crm.name?.() ?? `Customer ${id}`,
            portfolio: crm.portfolio?.() ?? 'north',
          },
        }),
      },
    }),
    connect(invoices, {
      providerAccountId: 'example-account',
      connectionId: 'billing',
      connector: {
        identify: async () => 'example-account',
        fetch: async (id) => ({
          providerAccountId: 'example-account',
          state: 'present',
          record: { id },
        }),
      },
    }),
  ];
}

function reviewApp(
  store: ObservationStore,
  graphId: string = randomUUID(),
  crm: {
    now?: () => number;
    name?: () => string;
    portfolio?: () => string;
  } = {},
) {
  return createRuntime({
    graph,
    graphId,
    store,
    ...(crm.now ? { clock: crm.now } : {}),
    actionImplementations: [addAccountReview],
    connections: reviewConnections(crm),
  });
}

describe('memory activity', () => {
  it('rejects activity reads when unsupported but keeps object provenance', async () => {
    const runtime = reviewApp(createMemoryStore({ activity: false }));
    const customer = await runtime.host.adopt(Customer, 'mothlight');
    const receipt = await runtime.as(ana).actions.addAccountReview({
      input: { customer, note: 'Without activity' },
      idempotencyKey: 'review',
    });

    expect(await runtime.host.activity.status()).toEqual({
      state: 'unsupported',
    });
    await expect(runtime.host.activity.feed.read()).rejects.toMatchObject({
      code: 'unsupported',
    });
    await expect(runtime.host.activity.operations.list()).rejects.toMatchObject(
      { code: 'unsupported' },
    );
    expect(
      await runtime.host.provenance({
        objectDefinitionId: Customer.id,
        objectId: customer,
      }),
    ).toMatchObject({ kind: 'adopted', actor: { id: 'relate.host' } });
    expect(
      await runtime.host.provenance({
        objectDefinitionId: 'business.account-review',
        objectId:
          receipt.state === 'succeeded' ? receipt.output.reviewId : 'missing',
      }),
    ).toMatchObject({
      kind: 'created',
      actor: { kind: 'principal', id: 'ana' },
      invocationId: receipt.invocationId,
    });
    expect(
      await runtime.host.provenance({
        objectDefinitionId: Customer.id,
        objectId: 'missing',
      }),
    ).toBeUndefined();
    expect(
      await runtime.host.provenance({
        objectDefinitionId: 'unknown.object',
        objectId: customer,
      }),
    ).toBeUndefined();
    await runtime.close();
  });

  it('rejects a store that advertises activity without atomic feed recording', () => {
    const store = createMemoryStore();

    expect(() =>
      reviewApp({
        ...store,
        activity: {
          ...store.activity!,
          atomicFeed: { sourceAcceptance: true, nativeTransactions: false },
        },
      }),
    ).toThrow(/atomic feed/);
  });

  it('evicts a feed prefix, expires older cursors and keeps provenance', async () => {
    const store = createMemoryStore({
      activity: { feedEntries: 2, operations: 1 },
    });
    const graphId = randomUUID();
    const runtime = reviewApp(store, graphId);
    const first = await runtime.host.adopt(Customer, 'one');
    const early = await runtime.host.activity.feed.read();

    await runtime.host.adopt(Customer, 'two');
    await runtime.host.adopt(Customer, 'three');

    const retained = await runtime.host.activity.feed.read();

    expect(retained.entries.map((entry) => entry.position)).toEqual(['2', '3']);
    // Entries stand alone: actor and context survive operation eviction.
    expect(retained.entries[0]).toMatchObject({
      actor: { kind: 'system', id: 'relate.host' },
      context: { transport: 'embedded' },
    });
    await expect(
      runtime.host.activity.feed.read({ cursor: early.nextCursor }),
    ).resolves.toMatchObject({
      entries: [{ position: '2' }, { position: '3' }],
    });

    await runtime.host.adopt(Customer, 'four');
    await expect(
      runtime.host.activity.feed.read({ cursor: early.nextCursor }),
    ).rejects.toMatchObject({ code: 'cursor-expired' });
    expect(
      await runtime.host.provenance({
        objectDefinitionId: Customer.id,
        objectId: first,
      }),
    ).toMatchObject({ kind: 'adopted' });
    await vi.waitFor(async () =>
      expect(
        (await runtime.host.activity.operations.list()).entries,
      ).toHaveLength(1),
    );

    // A replacement store is a new stream: old cursors expire explicitly.
    const replacement = reviewApp(createMemoryStore(), graphId);

    await replacement.host.adopt(Customer, 'one');
    await expect(
      replacement.host.activity.feed.read({ cursor: retained.nextCursor }),
    ).rejects.toMatchObject({ code: 'cursor-expired' });
    await runtime.close();
    await replacement.close();
  });

  it('rolls back writes whose feed batch exceeds retained limits', async () => {
    const store = createMemoryStore({ activity: { rowBytes: 100 } });
    const runtime = reviewApp(store);

    await expect(runtime.host.adopt(Customer, 'mothlight')).rejects.toThrow();

    const roomy = createMemoryStore({ activity: { feedEntries: 2 } });
    const reviews = reviewApp(roomy);
    const customer = await reviews.host.adopt(Customer, 'mothlight');

    // Creation plus its invocation event fit; with the adoption retained the
    // prefix is evicted, never part of the new batch.
    await reviews.as(ana).actions.addAccountReview({
      input: { customer, note: 'Fits' },
      idempotencyKey: 'fits',
    });
    expect(
      (await reviews.host.activity.feed.read()).entries.map((e) => e.kind),
    ).toEqual(['created', 'invocation-succeeded']);
    await runtime.close();
    await reviews.close();
  });

  it('records traversal lineage with its origin and authorized fields', async () => {
    const { graph, customers, invoices, Customer, Invoice, finance, ana } =
      createInvoiceGraph();
    const runtime = createRuntime({
      graph,
      graphId: randomUUID(),
      connections: [
        connect(customers, {
          providerAccountId: 'example-account',
          connectionId: 'crm',
          connector: {
            identify: async () => 'example-account',
            fetch: async (id) => ({
              providerAccountId: 'example-account',
              state: 'present',
              record: { id, name: 'Mothlight', portfolio: 'north', revenue: 1 },
            }),
          },
        }),
        connect(invoices, {
          providerAccountId: 'example-account',
          connectionId: 'billing',
          connector: {
            identify: async () => 'example-account',
            fetch: async (id) => ({
              providerAccountId: 'example-account',
              state: 'present',
              record: {
                id,
                customer_id: 'mothlight',
                status: 'paid',
                total_minor: 100,
              },
            }),
          },
        }),
      ],
    });
    const customer = await runtime.host.adopt(Customer, 'mothlight');
    const invoiceIds = [
      await runtime.host.adopt(Invoice, 'inv_01'),
      await runtime.host.adopt(Invoice, 'inv_02'),
    ];

    for (const principal of [ana, finance])
      await runtime.as(principal).objects.Customer.traverse.invoices(customer, {
        select: ['status', 'totalMinor'],
        refresh: true,
      });

    let traversals: readonly Operation[] = [];

    await vi.waitFor(async () => {
      traversals = (
        await runtime.host.activity.operations.list({
          filter: { kinds: ['traverse'] },
        })
      ).entries;
      expect(traversals).toHaveLength(2);
    });

    const [fin, anaTraversal] = traversals;
    const returned = (forbidden: string[]) =>
      [...invoiceIds].sort().map(() =>
        expect.objectContaining({
          objectDefinitionId: 'business.invoice',
          role: 'returned',
          forbidden,
        }),
      );

    expect(fin).toMatchObject({
      kind: 'traverse',
      definitionId: 'business.invoice',
      outcome: { status: 'ok' },
      details: {
        traversalId: 'business.customer-invoices',
        from: { objectDefinitionId: 'business.customer', objectId: customer },
        hasMore: false,
      },
      objects: [
        {
          objectDefinitionId: 'business.customer',
          objectId: customer,
          role: 'traversal-origin',
          returned: [],
          forbidden: [],
          unavailable: [],
        },
        ...returned([]),
      ],
    });
    expect(anaTraversal!.objects.slice(1)).toEqual(returned(['invoice.total']));
    const refreshes = (
      await runtime.host.activity.operations.list({
        filter: { kinds: ['refresh'] },
      })
    ).entries;

    expect(refreshes.length).toBeGreaterThan(0);

    for (const refresh of refreshes) {
      const parent = traversals.find(
        (row) => row.id === refresh.parentOperationId,
      );

      expect(parent).toBeDefined();
      expect(refresh).toMatchObject({
        actor: parent!.actor,
        context: parent!.context,
      });
    }

    expect(
      fin!.objects
        .slice(1)
        .map((object) => object.objectId)
        .sort(),
    ).toEqual([...invoiceIds].sort());
    await runtime.close();
  });

  it('records receipt lookups without claiming to execute', async () => {
    const runtime = reviewApp(createMemoryStore());
    const customer = await runtime.host.adopt(Customer, 'mothlight');
    const receipt = await runtime.as(ana).actions.addAccountReview({
      input: { customer, note: 'Look me up' },
      idempotencyKey: 'lookup',
    });

    await runtime
      .as(ana)
      .receipts.get('addAccountReview', receipt.invocationId);
    await expect(
      runtime.as(ana).receipts.get('addAccountReview', 'missing'),
    ).rejects.toMatchObject({ code: 'denied' });

    let lookups: readonly Operation[] = [];

    await vi.waitFor(async () => {
      lookups = (
        await runtime.host.activity.operations.list({
          filter: { kinds: ['receipt'] },
        })
      ).entries;
      expect(lookups).toHaveLength(2);
    });
    expect(lookups.map((operation) => operation.outcome)).toEqual([
      { status: 'rejected', code: 'denied' },
      { status: 'succeeded' },
    ]);
    expect(lookups[1]).toMatchObject({
      definitionId: AddAccountReview.id,
      invocationId: receipt.invocationId,
    });
    expect('replayed' in lookups[1]!).toBe(false);
    expect(
      (
        await runtime.host.activity.feed.read({
          filter: { kinds: ['invocation-succeeded'] },
        })
      ).entries,
    ).toHaveLength(1);
    await runtime.close();
  });

  it('keeps refreshes made by receipt authorization, nested under the attempt', async () => {
    let now = 1_000_000;
    let name = 'Mothlight';
    let portfolio = 'north';
    const runtime = reviewApp(createMemoryStore(), randomUUID(), {
      now: () => now,
      name: () => name,
      portfolio: () => portfolio,
    });
    const customer = await runtime.host.adopt(Customer, 'mothlight');
    const request = {
      input: { customer, note: 'Replay me' },
      idempotencyKey: 'replay',
    };
    const receipt = await runtime.as(ana).actions.addAccountReview(request);

    // Stale evidence: the replay's receipt authorization refreshes the customer.
    now += 120_000;
    name = 'Mothlight Studio';
    expect(await runtime.as(ana).actions.addAccountReview(request)).toEqual(
      receipt,
    );
    // The customer moves away: the replay is denied, its refresh still commits.
    now += 120_000;
    name = 'Mothlight Moved';
    portfolio = 'south';
    await expect(
      runtime.as(ana).actions.addAccountReview(request),
    ).rejects.toMatchObject({ code: 'denied' });

    const updates = (
      await runtime.host.activity.feed.read({ filter: { kinds: ['updated'] } })
    ).entries as readonly Change[];
    let invokes: readonly Operation[] = [];

    await vi.waitFor(async () => {
      invokes = (
        await runtime.host.activity.operations.list({
          filter: { kinds: ['invoke'] },
        })
      ).entries;
      expect(invokes).toHaveLength(3);
    });

    const [denied, replay] = invokes;

    expect(updates).toHaveLength(2);
    expect(updates.map((update) => update.parentOperationId)).toEqual([
      replay!.id,
      denied!.id,
    ]);

    for (const update of updates) {
      expect(update.invocationId).toBeUndefined();
      expect(update).toMatchObject({
        actor: { kind: 'source', id: customers.id },
        triggeredBy: { kind: 'principal', id: 'ana' },
      });
    }

    expect(replay).toMatchObject({
      replayed: true,
      invocationId: receipt.invocationId,
    });
    expect(denied).toMatchObject({
      outcome: { status: 'rejected', code: 'denied' },
      replayed: false,
    });

    const nested = (
      await runtime.host.activity.operations.list({
        filter: { operationId: replay!.id, kinds: ['refresh'] },
      })
    ).entries;

    expect(nested).toEqual([
      expect.objectContaining({
        parentOperationId: replay!.id,
        details: { refresh: 'changed' },
      }),
    ]);
    expect('invocationId' in nested[0]!).toBe(false);
    // No native change or invocation event from either replay attempt.
    expect(
      (
        await runtime.host.activity.feed.read({
          filter: { kinds: ['created', 'invocation-succeeded'] },
        })
      ).entries,
    ).toHaveLength(2);
    await runtime.close();
  });

  it.each(['native-read', 'receipt'] as const)(
    'passes the %s scope through private authorization refreshes',
    async (kind) => {
      const store = createMemoryStore();
      const graphId = randomUUID();
      let now = 1_000_000;
      let name = 'Before';
      const runtime = reviewApp(store, graphId, {
        now: () => now,
        name: () => name,
      });

      onTestFinished(() => runtime.close());
      const customer = await runtime.host.adopt(Customer, 'one');
      const receipt = await runtime.as(ana).actions.addAccountReview({
        input: { customer, note: 'Review' },
        idempotencyKey: 'one',
      });
      const context = { requestId: kind, transport: 'http' as const };
      const operations = runtime.operations(ana, context);

      now += 120_000;
      name = 'After';

      if (kind === 'native-read')
        expect(
          await operations.get(AccountReview.id, receipt.output.reviewId),
        ).toMatchObject({ status: 'ok' });
      else
        expect(
          await operations.getReceipt(
            AddAccountReview.id,
            receipt.invocationId,
          ),
        ).toEqual(receipt);

      await runtime.close();

      const rows = (
        await store.activity!.operations.list(graphId, {
          filter: { requestId: kind },
        })
      ).entries;
      const parent = rows.find(
        (row) => row.kind === (kind === 'native-read' ? 'get' : 'receipt'),
      )!;
      const refresh = rows.find((row) => row.kind === 'refresh')!;

      expect(rows).toHaveLength(2);
      expect(refresh).toMatchObject({
        parentOperationId: parent.id,
        actor: { kind: 'principal', id: ana.id },
        context,
        details: { refresh: 'changed' },
      });
      expect(
        (
          await store.activity!.feed.read(graphId, {
            filter: { kinds: ['updated'] },
          })
        ).entries,
      ).toEqual([
        expect.objectContaining({
          operationId: refresh.id,
          parentOperationId: parent.id,
          triggeredBy: parent.actor,
          context,
        }),
      ]);
    },
  );

  it('truncates oversized lineage and says so', async () => {
    const runtime = createRuntime({
      graph,
      graphId: randomUUID(),
      store: createMemoryStore(),
      activity: { maxObjects: 1 },
      actionImplementations: [addAccountReview],
      connections: reviewConnections(),
    });

    await runtime.host.adopt(Customer, 'one');
    await runtime.host.adopt(Customer, 'two');
    await runtime.as(ana).objects.Customer.query({ select: ['name'] });

    let queries: readonly Operation[] = [];

    await vi.waitFor(async () => {
      queries = (
        await runtime.host.activity.operations.list({
          filter: { kinds: ['query'] },
        })
      ).entries;
      expect(queries).toHaveLength(1);
    });
    expect(queries[0]!.objects).toHaveLength(1);
    expect(queries[0]!.details).toEqual({
      hasMore: false,
      truncated: { omittedObjects: 1 },
    });
    expect(runtime.host.activityCounters().truncated).toBe(1);
    await runtime.close();
  });

  it('fails an invoke before its handler runs when the store cannot stage feed entries', async () => {
    const store = createMemoryStore();
    const native = store.native!;
    let ran = false;
    const runtime = createRuntime({
      graph,
      graphId: randomUUID(),
      store: {
        ...store,
        native: {
          ...native,
          transaction: (scope, callback) =>
            native.transaction(scope, (transaction) => {
              const { appendFeed: _appendFeed, ...withoutFeed } = transaction;

              return callback(withoutFeed);
            }),
        },
      },
      actionImplementations: [
        implementAction(graph, AddAccountReview, async (context) => {
          ran = true;

          return addAccountReview.implementation(context);
        }),
      ],
      connections: reviewConnections(),
    });
    const customer = await runtime.host.adopt(Customer, 'mothlight');

    await expect(
      runtime.as(ana).actions.addAccountReview({
        input: { customer, note: 'No feed' },
        idempotencyKey: 'no-feed',
      }),
    ).rejects.toMatchObject({ code: 'internal' });
    expect(ran).toBe(false);
    expect(
      (await runtime.host.activity.feed.read()).entries.map((e) => e.kind),
    ).toEqual(['adopted']);
    await runtime.close();
  });

  it('records a refresh as superseded when the competing winner is gone', async () => {
    let now = 1_000_000;
    const store = createMemoryStore();
    let vanish = false;
    let stale = false;
    const runtime = reviewApp(
      {
        ...store,
        // A fetch token older than the stored observation loses to it.
        beginFetch: async () =>
          stale ? ((vanish = true), '0') : store.beginFetch(),
        load: async (scope, objectId) =>
          vanish ? undefined : store.load(scope, objectId),
      },
      randomUUID(),
      { now: () => now },
    );
    const customer = await runtime.host.adopt(Customer, 'mothlight');

    now += 120_000;
    stale = true;
    await runtime.as(ana).objects.Customer.get(customer, { select: ['name'] });

    let refreshes: readonly Operation[] = [];

    await vi.waitFor(async () => {
      refreshes = (
        await runtime.host.activity.operations.list({
          filter: { kinds: ['refresh'] },
        })
      ).entries;
      expect(refreshes).toHaveLength(1);
    });
    expect(refreshes[0]).toMatchObject({
      outcome: { status: 'ok' },
      details: { refresh: 'superseded' },
    });
    await runtime.close();
  });

  it('records a lost commit acknowledgement as uncertain and keeps the committed feed', async () => {
    const store = createMemoryStore();
    const native = store.native!;
    const runtime = reviewApp({
      ...store,
      native: {
        ...native,
        async transaction(scope, callback) {
          await native.transaction(scope, callback);
          throw new NativeCommitUncertain();
        },
      },
    });
    const customer = await runtime.host.adopt(Customer, 'mothlight');

    await expect(
      runtime.as(ana).actions.addAccountReview({
        input: { customer, note: 'Committed, unacknowledged' },
        idempotencyKey: 'uncertain',
      }),
    ).rejects.toMatchObject({ code: 'uncertain' });

    // The feed is authoritative for what committed.
    const feed = (await runtime.host.activity.feed.read()).entries;

    expect(feed.map((e) => e.kind)).toEqual([
      'adopted',
      'created',
      'invocation-succeeded',
    ]);

    let invokes: readonly Operation[] = [];

    await vi.waitFor(async () => {
      invokes = (
        await runtime.host.activity.operations.list({
          filter: { kinds: ['invoke'] },
        })
      ).entries;
      expect(invokes).toHaveLength(1);
    });
    expect(invokes[0]!.outcome).toEqual({ status: 'uncertain' });
    expect(invokes[0]).not.toHaveProperty('invocationId');
    // The attempt still links to what it committed.
    expect(feed[1]!.operationId).toBe(invokes[0]!.id);
    await runtime.close();
  });

  it('dispatches under a transport-assigned operation ID, always as the principal', async () => {
    const runtime = reviewApp(createMemoryStore());
    const customer = await runtime.host.adopt(Customer, 'mothlight');
    const operationId = '01920000-0000-7000-8000-000000000001';

    expect(
      await runtime.host.dispatch(
        ana,
        {
          operationId,
          context: {
            requestId: 'dev-request',
            transport: 'mcp',
            runtimeId: 'runtime-1',
          },
        },
        'get',
        [Customer.id, customer, { select: ['name'] }],
      ),
    ).toMatchObject({ status: 'ok', id: customer });

    let gets: readonly Operation[] = [];

    await vi.waitFor(async () => {
      gets = (
        await runtime.host.activity.operations.list({
          filter: { kinds: ['get'] },
        })
      ).entries;
      expect(gets).toHaveLength(1);
    });
    expect(gets[0]).toMatchObject({
      id: operationId,
      actor: { kind: 'principal', id: 'ana' },
      context: {
        requestId: 'dev-request',
        transport: 'mcp',
        runtimeId: 'runtime-1',
      },
    });

    for (const [attempt, method] of [
      [{ operationId: 'not-a-uuid' }, 'get'],
      [{ operationId: randomUUID() }, 'get'],
      [{ operationId, context: { transport: 'smtp' } }, 'get'],
      [{ operationId }, 'discovery'],
    ] as const)
      await expect(
        runtime.host.dispatch(ana, attempt as never, method as never, [
          Customer.id,
          customer,
        ]),
      ).rejects.toThrow();

    await runtime.close();
  });
});
