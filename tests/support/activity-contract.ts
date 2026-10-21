import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { bind, implementAction } from 'relate';
import type { ActionContext } from 'relate';
import { compile } from 'relate/compiler';
import { createRuntime } from '@relate/node';
import { uuidv7 } from '@relate/runtime';
import { ActivityError } from '@relate/protocol';
import type {
  Change,
  FeedEntry,
  InvocationEvent,
  Operation,
} from '@relate/protocol';
import type { ObservationStore } from '@relate/runtime/storage';
import { domainGraph, Review } from './domain-action-contract.js';
import {
  AccountReview,
  Customer,
  ana,
  customers,
} from './native-action-model.js';
import { createCustomerGraph } from './customer-graph.js';

type ReviewContext = ActionContext<typeof domainGraph, typeof Review>;

const review = async ({ actor, input, objects, fail }: ReviewContext) => {
  const customer = await objects.Customer.get(input.customer, {
    select: ['id'],
  });

  if (customer.status !== 'ok') throw new Error('Customer unavailable');

  const created = await objects.AccountReview.create({
    customer: customer.id,
    author: actor.id,
    note: input.note,
  });

  if (input.note === 'fail') fail('inactive', {});

  return { reviewId: created.id };
};

const isChange = (entry: FeedEntry): entry is Change => 'object' in entry;

const { definitionRevision } = compile(domainGraph);

/**
 * Activity guarantees shared by every store that advertises activity: atomic
 * feed recording with object state, best-effort operations, permanent object
 * provenance and checkpointed feed reading.
 */
export function activityContract(
  name: string,
  open: () => Promise<{
    store: ObservationStore;
    close(): Promise<void>;
    reopen?(): Promise<ObservationStore & { close(): Promise<void> }>;
  }>,
) {
  describe(name, () => {
    let backing: Awaited<ReturnType<typeof open>>;
    let graphId: string;
    let crm: Map<
      string,
      { state: 'present' | 'deleted'; name: string; portfolio: string }
    >;
    let release: (() => void) | undefined;

    beforeEach(async () => {
      backing = await open();
      graphId = randomUUID();
      crm = new Map([
        [
          'mothlight',
          { state: 'present', name: 'Mothlight', portfolio: 'north' },
        ],
      ]);
      release = undefined;
    });
    afterEach(async () => {
      release?.();
      await backing.close();
    });

    it('persists bounded analytical timings without changing elapsed duration', async () => {
      await backing.store.install(graphId, definitionRevision);
      const id = uuidv7();
      const analytical = {
        stages: {
          dependencyReads: { count: 2, totalMs: 15, maxMs: 9 },
          execution: { count: 1, totalMs: 4, maxMs: 4 },
        },
      };

      await backing.store.activity!.appendOperations(graphId, [
        {
          schemaVersion: 1,
          id,
          graphId,
          definitionRevision,
          actor: { kind: 'principal', id: 'ana' },
          context: { requestId: id, transport: 'embedded' },
          startedAt: new Date(0).toISOString(),
          completedAt: new Date(10).toISOString(),
          durationMs: 10,
          objects: [],
          kind: 'query',
          definitionId: Customer.id,
          outcome: { status: 'ok' },
          details: { analytical, hasMore: false },
        },
      ]);
      const row = (await backing.store.activity!.operations.list(graphId))
        .entries[0]!;

      expect(row.durationMs).toBe(10);
      expect(row.details.analytical).toEqual(analytical);

      if (backing.reopen) {
        const reopened = await backing.reopen();

        try {
          expect(
            (await reopened.activity!.operations.list(graphId)).entries[0]!
              .details.analytical,
          ).toEqual(analytical);
        } finally {
          await reopened.close();
        }
      }
    });

    function crmConnection() {
      return bind(customers, {
        providerAccountId: 'example-account',
        connectionId: 'crm',
        resourceId: 'records',
        connector: {
          identify: async () => 'example-account',
          async fetch(id) {
            const record = crm.get(id);

            if (!record || record.state === 'deleted')
              return { providerAccountId: 'example-account', state: 'deleted' };

            return {
              providerAccountId: 'example-account',
              state: 'present',
              record: { id, name: record.name, portfolio: record.portfolio },
            };
          },
        },
      });
    }

    function reviews(
      options: {
        store?: ObservationStore;
        handler?: (context: ReviewContext) => ReturnType<typeof review>;
        activity?: Parameters<typeof createRuntime>[0]['activity'];
      } = {},
    ) {
      return createRuntime({
        graph: domainGraph,
        graphId,
        store: options.store ?? backing.store,
        ...(options.activity ? { activity: options.activity } : {}),
        actionImplementations: [
          implementAction(domainGraph, Review, options.handler ?? review),
        ],
        bindings: [crmConnection()],
      });
    }

    async function feed(
      runtime: ReturnType<typeof reviews>,
      filter?: NonNullable<
        Parameters<
          ReturnType<typeof reviews>['host']['activity']['feed']['read']
        >[0]
      >['filter'],
    ): Promise<FeedEntry[]> {
      const entries: FeedEntry[] = [];
      let page = await runtime.host.activity.feed.read({
        ...(filter ? { filter } : {}),
        limit: 500,
      });

      entries.push(...page.entries);

      while (page.hasMore) {
        page = await runtime.host.activity.feed.read({
          cursor: page.nextCursor,
          limit: 500,
        });
        entries.push(...page.entries);
      }

      return entries;
    }

    /** Operation rows arrive asynchronously; wait for the expected rows. */
    async function operations(
      runtime: { host: ReturnType<typeof reviews>['host'] },
      expected: number,
      filter?: Parameters<
        ReturnType<typeof reviews>['host']['activity']['operations']['list']
      >[0],
    ): Promise<Operation[]> {
      let entries: readonly Operation[] = [];

      await vi.waitFor(
        async () => {
          entries = (
            await runtime.host.activity.operations.list({
              limit: 500,
              ...(filter ?? {}),
            })
          ).entries;
          expect(entries.length).toBeGreaterThanOrEqual(expected);
        },
        { timeout: 5_000, interval: 10 },
      );

      return [...entries];
    }

    it('commits a creation with its provenance, receipt, change and invocation event', async () => {
      const runtime = reviews();
      const customer = await runtime.host.adopt(Customer, 'mothlight');
      const receipt = await runtime.as(ana).actions.review({
        input: { customer, note: 'Renewal call booked' },
        idempotencyKey: 'review-1',
      });

      expect(receipt.state).toBe('succeeded');

      const reviewId =
        receipt.state === 'succeeded' ? receipt.output.reviewId : '';
      const entries = await feed(runtime);

      expect(entries.map((entry) => entry.kind)).toEqual([
        'adopted',
        'created',
        'invocation-succeeded',
      ]);
      expect(entries.map((entry) => entry.position)).toEqual(
        [...entries.map((entry) => entry.position)].sort(
          (a, b) => Number(a) - Number(b),
        ),
      );

      const [adopted, created, succeeded] = entries as [
        Change,
        Change,
        InvocationEvent,
      ];

      expect(adopted).toMatchObject({
        kind: 'adopted',
        object: { objectDefinitionId: Customer.id, objectId: customer },
        sourceDefinitionId: customers.id,
        actor: { kind: 'system', id: 'relate.host' },
        changedPropertyIds: ['customer.name', 'customer.portfolio'],
      });
      expect(adopted.invocationId).toBeUndefined();
      expect(adopted.triggeredBy).toBeUndefined();
      expect(created).toMatchObject({
        schemaVersion: 1,
        graphId,
        kind: 'created',
        object: { objectDefinitionId: AccountReview.id, objectId: reviewId },
        changedPropertyIds: ['review.author', 'review.customer', 'review.note'],
        invocationId: receipt.invocationId,
        actor: { kind: 'principal', id: 'ana' },
        context: { transport: 'embedded' },
      });
      expect(created.sourceDefinitionId).toBeUndefined();
      expect(succeeded).toMatchObject({
        kind: 'invocation-succeeded',
        actionDefinitionId: Review.id,
        invocationId: receipt.invocationId,
        operationId: created.operationId,
        actor: { kind: 'principal', id: 'ana' },
      });
      expect(succeeded.context).toEqual(created.context);
      // No property values, inputs or outputs appear in any feed entry.
      expect(JSON.stringify(entries)).not.toContain('Renewal call booked');
      expect(JSON.stringify(entries)).not.toContain('Mothlight');

      expect(
        await runtime.host.provenance({
          objectDefinitionId: AccountReview.id,
          objectId: reviewId,
        }),
      ).toEqual({
        kind: 'created',
        actor: { kind: 'principal', id: 'ana' },
        at: expect.any(String),
        invocationId: receipt.invocationId,
      });
      expect(
        await runtime.host.provenance({
          objectDefinitionId: Customer.id,
          objectId: customer,
        }),
      ).toEqual({
        kind: 'adopted',
        actor: { kind: 'system', id: 'relate.host' },
        at: expect.any(String),
        sourceDefinitionId: customers.id,
      });

      const [invoke] = await operations(runtime, 1, {
        filter: { kinds: ['invoke'] },
      });

      expect(invoke).toMatchObject({
        id: created.operationId,
        kind: 'invoke',
        definitionId: Review.id,
        outcome: { status: 'succeeded' },
        invocationId: receipt.invocationId,
        replayed: false,
        actor: { kind: 'principal', id: 'ana' },
        objects: [],
      });

      // Nor does any operation row, including the adoption that fetched it.
      const all = await operations(runtime, 2);

      expect(JSON.stringify(all)).not.toContain('Renewal call booked');
      expect(JSON.stringify(all)).not.toContain('Mothlight');
      await runtime.close();
    });

    it('replays a retry without a new invocation, change or invocation event', async () => {
      const runtime = reviews();
      const customer = await runtime.host.adopt(Customer, 'mothlight');
      const request = {
        input: { customer, note: 'Renewal call booked' },
        idempotencyKey: 'review-1',
      };
      const first = await runtime.as(ana).actions.review(request);
      const before = await feed(runtime);
      const replay = await runtime.as(ana).actions.review(request);

      expect(replay).toEqual(first);
      expect(await feed(runtime)).toEqual(before);

      const invokes = await operations(runtime, 2, {
        filter: { kinds: ['invoke'] },
      });

      expect(invokes.map((operation) => operation.id)).toHaveLength(2);
      expect(new Set(invokes.map((operation) => operation.id)).size).toBe(2);
      expect(
        invokes.map((operation) => ({
          replayed: 'replayed' in operation && operation.replayed,
          invocationId: 'invocationId' in operation && operation.invocationId,
        })),
      ).toEqual([
        { replayed: true, invocationId: first.invocationId },
        { replayed: false, invocationId: first.invocationId },
      ]);
      await runtime.close();
    });

    it('records only the failed receipt event for a domain failure', async () => {
      const runtime = reviews();
      const customer = await runtime.host.adopt(Customer, 'mothlight');
      const receipt = await runtime.as(ana).actions.review({
        input: { customer, note: 'fail' },
        idempotencyKey: 'failing',
      });

      expect(receipt.state).toBe('failed');

      const entries = await feed(runtime, {
        kinds: ['created', 'invocation-failed', 'invocation-succeeded'],
      });

      expect(entries).toEqual([
        expect.objectContaining({
          kind: 'invocation-failed',
          failureCode: 'inactive',
          invocationId: receipt.invocationId,
        }),
      ]);
      await runtime.close();
    });

    it('records a rejected action as an operation without an invocation or feed entry', async () => {
      const runtime = reviews();
      const customer = await runtime.host.adopt(Customer, 'mothlight');
      const reader = { ...ana, id: 'reader', roles: ['employee'] };

      await expect(
        runtime.as(reader).actions.review({
          input: { customer, note: 'Not allowed' },
          idempotencyKey: 'denied',
        }),
      ).rejects.toMatchObject({ code: 'denied' });
      expect((await feed(runtime)).map((entry) => entry.kind)).toEqual([
        'adopted',
      ]);

      const [denied] = await operations(runtime, 1, {
        filter: { kinds: ['invoke'] },
      });

      expect(denied).toMatchObject({
        outcome: { status: 'rejected', code: 'denied' },
        replayed: false,
        actor: { kind: 'principal', id: 'reader' },
      });
      expect('invocationId' in denied!).toBe(false);
      await runtime.close();
    });

    it('rolls back objects and receipts when the feed write fails', async () => {
      const native = backing.store.native!;
      const failing: ObservationStore = {
        ...backing.store,
        native: {
          ...native,
          transaction: (scope, operation) =>
            native.transaction(scope, (transaction) =>
              operation({
                ...transaction,
                async appendFeed() {
                  throw new Error('Injected feed failure');
                },
              }),
            ),
        },
      };
      const runtime = reviews({ store: failing });
      const customer = await runtime.host.adopt(Customer, 'mothlight');

      await expect(
        runtime.as(ana).actions.review({
          input: { customer, note: 'Never committed' },
          idempotencyKey: 'feed-failure',
        }),
      ).rejects.toMatchObject({ code: 'internal' });
      expect(
        await native.loadInvocation(
          { graphId, definitionRevision },
          Review.id,
          'feed-failure',
        ),
      ).toBeUndefined();
      expect(
        (
          await native.scan({ graphId, definitionRevision }, AccountReview.id, {
            limit: 10,
          })
        ).objects,
      ).toEqual([]);
      expect((await feed(runtime)).map((entry) => entry.kind)).toEqual([
        'adopted',
      ]);
      await runtime.close();
    });

    it('nests a read-triggered refresh and attributes its change to the source', async () => {
      const runtime = reviews();
      const customer = await runtime.host.adopt(Customer, 'mothlight');

      crm.set('mothlight', {
        state: 'present',
        name: 'Mothlight Studio',
        portfolio: 'north',
      });
      await runtime
        .as(ana)
        .objects.Customer.get(customer, { select: ['name'], refresh: true });

      const updated = (await feed(runtime)).at(-1) as Change;

      expect(updated).toMatchObject({
        kind: 'updated',
        object: { objectDefinitionId: Customer.id, objectId: customer },
        changedPropertyIds: ['customer.name'],
        actor: { kind: 'source', id: customers.id },
        triggeredBy: { kind: 'principal', id: 'ana' },
        sourceDefinitionId: customers.id,
      });
      expect(updated.invocationId).toBeUndefined();

      const all = await operations(runtime, 3);
      const read = all.find((operation) => operation.kind === 'get')!;
      const refresh = all.find((operation) => operation.kind === 'refresh')!;

      expect(updated.parentOperationId).toBe(read.id);
      expect(updated.operationId).toBe(refresh.id);
      expect(refresh).toMatchObject({
        parentOperationId: read.id,
        actor: { kind: 'principal', id: 'ana' },
        outcome: { status: 'ok' },
        details: { refresh: 'changed' },
        target: { objectDefinitionId: Customer.id, objectId: customer },
      });
      expect(refresh.context).toEqual(read.context);
      expect(read).toMatchObject({
        kind: 'get',
        outcome: { status: 'ok' },
        objects: [
          {
            objectDefinitionId: Customer.id,
            objectId: customer,
            role: 'target',
            returned: ['customer.name'],
            forbidden: [],
            unavailable: [],
          },
        ],
      });

      // Actor filters match the source actor, not the triggering principal.
      expect(
        (await feed(runtime, { actor: { kind: 'source', id: customers.id } }))
          .length,
      ).toBe(1);
      expect(
        (await feed(runtime, { actor: { kind: 'principal', id: 'ana' } }))
          .length,
      ).toBe(0);
      await runtime.close();
    });

    it('records unchanged refreshes and fresh reads without feed entries', async () => {
      const runtime = reviews();
      const customer = await runtime.host.adopt(Customer, 'mothlight');

      // Fresh observation: no fetch, no refresh operation.
      await runtime
        .as(ana)
        .objects.Customer.get(customer, { select: ['name'] });
      // Same mapped values: the observation advances, nothing changes.
      await runtime
        .as(ana)
        .objects.Customer.get(customer, { select: ['name'], refresh: true });

      expect((await feed(runtime)).map((entry) => entry.kind)).toEqual([
        'adopted',
      ]);

      const refreshes = await operations(runtime, 1, {
        filter: { kinds: ['refresh'] },
      });

      await operations(runtime, 4);
      expect(refreshes).toHaveLength(1);
      expect(refreshes[0]).toMatchObject({
        outcome: { status: 'ok' },
        details: { refresh: 'unchanged' },
      });
      await runtime.close();
    });

    it('records deletion and restoration from the source', async () => {
      const runtime = reviews();
      const customer = await runtime.host.adopt(Customer, 'mothlight');
      const read = () =>
        runtime
          .as(ana)
          .objects.Customer.get(customer, { select: ['name'], refresh: true });

      crm.set('mothlight', { state: 'deleted', name: '', portfolio: '' });
      expect((await read()).status).toBe('not-found');
      crm.set('mothlight', {
        state: 'present',
        name: 'Back',
        portfolio: 'north',
      });
      // A tombstone is not readable, so restoration arrives through adoption.
      await runtime.host.adopt(Customer, 'mothlight', {
        actor: { kind: 'principal', id: 'ops' },
      });

      const changes = (await feed(runtime)).filter(isChange);

      expect(
        changes.map((change) => [change.kind, change.changedPropertyIds]),
      ).toEqual([
        ['adopted', ['customer.name', 'customer.portfolio']],
        ['deleted', []],
        ['restored', []],
      ]);
      expect(changes[2]).toMatchObject({
        actor: { kind: 'source', id: customers.id },
        triggeredBy: { kind: 'principal', id: 'ops' },
      });
      await runtime.close();
    });

    it('keeps an earlier checkpoint from skipping a change that commits behind it', async () => {
      let entered!: () => void;
      const handlerStarted = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const blocked = new Promise<void>((resolve) => {
        release = resolve;
      });
      const runtime = reviews({
        handler: async (context) => {
          entered();
          await blocked;

          return review(context);
        },
      });
      const customer = await runtime.host.adopt(Customer, 'mothlight');
      const pending = runtime.as(ana).actions.review({
        input: { customer, note: 'Slow writer' },
        idempotencyKey: 'slow',
      });

      await handlerStarted;
      // A later writer commits first, while the native writer is still open.
      crm.set('mothlight', {
        state: 'present',
        name: 'Renamed',
        portfolio: 'north',
      });
      await runtime
        .as(ana)
        .objects.Customer.get(customer, { select: ['name'], refresh: true });

      const checkpoint = await runtime.host.activity.feed.read();

      expect(checkpoint.entries.map((entry) => entry.kind)).toEqual([
        'adopted',
        'updated',
      ]);
      release!();
      await pending;

      const next = await runtime.host.activity.feed.read({
        cursor: checkpoint.nextCursor,
      });

      expect(next.entries.map((entry) => entry.kind)).toEqual([
        'created',
        'invocation-succeeded',
      ]);
      expect(Number(next.entries[0]!.position)).toBeGreaterThan(
        Number(checkpoint.entries.at(-1)!.position),
      );
      await runtime.close();
    });

    it('pages the feed by checkpoint with stored filters', async () => {
      const runtime = reviews();
      const customer = await runtime.host.adopt(Customer, 'mothlight');

      for (const key of ['a', 'b'])
        await runtime.as(ana).actions.review({
          input: { customer, note: `Review ${key}` },
          idempotencyKey: key,
        });

      const first = await runtime.host.activity.feed.read({
        filter: { kinds: ['invocation-succeeded'] },
        limit: 1,
      });

      expect(first.entries).toHaveLength(1);
      expect(first.hasMore).toBe(true);

      const second = await runtime.host.activity.feed.read({
        cursor: first.nextCursor,
        limit: 1,
      });

      expect(second.entries.map((entry) => entry.kind)).toEqual([
        'invocation-succeeded',
      ]);
      expect(second.hasMore).toBe(false);

      // An empty filtered scan still advances past the scanned range.
      const empty = await runtime.host.activity.feed.read({
        cursor: second.nextCursor,
      });

      expect(empty).toMatchObject({ entries: [], hasMore: false });
      await expect(
        runtime.host.activity.feed.read({
          cursor: first.nextCursor,
          filter: { kinds: ['invocation-succeeded'] },
        } as never),
      ).rejects.toMatchObject({ code: 'invalid-request' });
      await expect(
        runtime.host.activity.feed.read({ cursor: 'not-a-cursor' }),
      ).rejects.toMatchObject({ code: 'invalid-cursor' });

      const operationsCursor = (await runtime.host.activity.operations.list())
        .nextCursor;

      await expect(
        runtime.host.activity.feed.read({ cursor: operationsCursor }),
      ).rejects.toBeInstanceOf(ActivityError);
      await expect(
        runtime.host.activity.feed.read({ limit: 501 }),
      ).rejects.toMatchObject({ code: 'invalid-request' });
      await runtime.close();
    });

    it('matches direct references only', async () => {
      const runtime = reviews();
      const customer = await runtime.host.adopt(Customer, 'mothlight');
      const object = { objectDefinitionId: Customer.id, objectId: customer };

      await runtime.as(ana).actions.review({
        input: { customer, note: 'For this customer' },
        idempotencyKey: 'direct',
      });
      await runtime.as(ana).objects.Customer.get(customer, { select: ['id'] });

      expect(
        (await feed(runtime, { object })).map((entry) => entry.kind),
      ).toEqual(['adopted']);

      const touching = await operations(runtime, 2, { filter: { object } });

      expect(touching.map((operation) => operation.kind).sort()).toEqual([
        'adopt',
        'get',
      ]);
      await expect(
        runtime.host.activity.operations.list({
          filter: {
            object,
            objectDefinitionId: AccountReview.id,
          },
        }),
      ).rejects.toMatchObject({ code: 'invalid-request' });
      await runtime.close();
    });

    it('gives each call its own operation and embedded request ID', async () => {
      const runtime = reviews();
      const customer = await runtime.host.adopt(Customer, 'mothlight');
      const embedded = runtime.operations(ana);
      const http = runtime.operations(ana, {
        requestId: 'req-http',
        transport: 'http',
      });

      await embedded.get(Customer.id, customer, { select: ['id'] });
      await embedded.get(Customer.id, customer, { select: ['id'] });
      await http.get(Customer.id, customer, { select: ['id'] });
      await http.get(Customer.id, customer, { select: ['id'] });

      const gets = await operations(runtime, 4, {
        filter: { kinds: ['get'] },
      });

      expect(new Set(gets.map((operation) => operation.id)).size).toBe(4);

      const requests = gets.map((operation) => operation.context);

      expect(
        requests.filter((context) => context.requestId === 'req-http'),
      ).toEqual([
        { requestId: 'req-http', transport: 'http' },
        { requestId: 'req-http', transport: 'http' },
      ]);

      const embeddedRequests = requests.filter(
        (context) => context.transport === 'embedded',
      );

      expect(new Set(embeddedRequests.map((c) => c.requestId)).size).toBe(2);
      await runtime.close();
    });

    it('records hidden and missing gets with the same requested target', async () => {
      const runtime = reviews();
      const hidden = await runtime.host.adopt(Customer, 'mothlight');
      const outsider = { ...ana, id: 'south', claims: { portfolio: 'south' } };

      expect(
        (await runtime.as(outsider).objects.Customer.get(hidden)).status,
      ).toBe('not-found');
      expect(
        (await runtime.as(outsider).objects.Customer.get('missing' as never))
          .status,
      ).toBe('not-found');

      const gets = await operations(runtime, 2, {
        filter: { kinds: ['get'] },
      });

      expect(
        gets.map((operation) => ({
          outcome: operation.outcome,
          objects: operation.objects,
        })),
      ).toEqual([
        {
          outcome: { status: 'not-found' },
          objects: [
            {
              objectDefinitionId: Customer.id,
              objectId: 'missing',
              role: 'target',
              returned: [],
              forbidden: [],
              unavailable: [],
            },
          ],
        },
        {
          outcome: { status: 'not-found' },
          objects: [
            {
              objectDefinitionId: Customer.id,
              objectId: hidden,
              role: 'target',
              returned: [],
              forbidden: [],
              unavailable: [],
            },
          ],
        },
      ]);
      await runtime.close();
    });

    it('keeps the feed and provenance when operation capture is disabled', async () => {
      const runtime = reviews({ activity: { operations: 'disabled' } });
      const customer = await runtime.host.adopt(Customer, 'mothlight');

      await runtime.as(ana).objects.Customer.get(customer);
      await runtime.close();

      const reader = reviews();

      expect(await reader.host.activity.status()).toEqual({
        state: 'available',
        durability: backing.store.durability,
        operationCapture: 'enabled',
      });
      expect((await feed(reader)).map((entry) => entry.kind)).toEqual([
        'adopted',
      ]);
      expect((await reader.host.activity.operations.list()).entries).toEqual(
        [],
      );
      expect(
        await reader.host.provenance({
          objectDefinitionId: Customer.id,
          objectId: customer,
        }),
      ).toMatchObject({ kind: 'adopted' });
      await reader.close();
    });

    it('does not let failing or hanging operation appends change results', async () => {
      const diagnostics: unknown[] = [];
      let calls = 0;
      const activity = backing.store.activity!;
      const flaky: ObservationStore = {
        ...backing.store,
        activity: {
          ...activity,
          appendOperations: (() => {
            if (++calls === 1) throw new Error('synchronous failure');

            // Never settles: occupies the single writer.
            return new Promise<void>(() => {});
          }) as typeof activity.appendOperations,
        },
      };
      const runtime = reviews({
        store: flaky,
        activity: {
          queueEntries: 2,
          flushTimeoutMs: 50,
          onDiagnostic: (diagnostic) => {
            diagnostics.push(diagnostic);
            throw new Error('diagnostic callbacks cannot break operations');
          },
        },
      });
      const customer = await runtime.host.adopt(Customer, 'mothlight');

      await vi.waitFor(() => expect(calls).toBe(1));

      for (let index = 0; index < 5; index++)
        expect(
          (
            await runtime
              .as(ana)
              .objects.Customer.get(customer, { select: ['name'] })
          ).status,
        ).toBe('ok');

      await vi.waitFor(() => expect(calls).toBe(2));

      const counters = runtime.host.activityCounters();

      expect(counters.dropped['append-failed']).toBe(1);
      expect(counters.dropped['queue-full']).toBeGreaterThan(0);
      expect(diagnostics).toContainEqual({
        type: 'dropped',
        reason: 'append-failed',
        count: 1,
        kinds: ['adopt'],
      });
      expect(JSON.stringify(diagnostics)).not.toContain(customer);
      // The hung append cannot hold shutdown past its flush deadline.
      await runtime.close();
    });

    it('appends operations first-write-wins without mixing lineage', async () => {
      const runtime = reviews();
      const customer = await runtime.host.adopt(Customer, 'mothlight');
      const [adopt] = await operations(runtime, 1);
      const activity = backing.store.activity!;
      const { recordedAt: _recordedAt, ...draft } = adopt!;
      const conflicting = {
        ...draft,
        objects: [
          {
            objectDefinitionId: Customer.id,
            objectId: 'other',
            role: 'target' as const,
            returned: [],
            forbidden: [],
            unavailable: [],
          },
        ],
      };

      await activity.appendOperations(graphId, [conflicting, conflicting]);

      const [stored] = await operations(runtime, 1);

      expect(stored).toEqual(adopt);
      expect(stored!.objects[0]!.objectId).toBe(customer);
      await expect(
        activity.appendOperations(graphId, [
          {
            ...draft,
            id: randomUUID(),
            kind: 'invoke',
            definitionId: Review.id,
            outcome: { status: 'succeeded' },
            replayed: true,
          } as never,
        ]),
      ).rejects.toThrow();
      await runtime.close();
    });

    it('drains captured operations on close', async () => {
      const runtime = reviews();

      await runtime.host.adopt(Customer, 'mothlight');
      await runtime.close();

      const reader = reviews();

      expect(
        (await reader.host.activity.operations.list()).entries.map(
          (operation) => operation.kind,
        ),
      ).toEqual(['adopt']);
      await reader.close();
    });

    it('preserves feed cursors and IDs across reopening a persistent store', async (context) => {
      if (!backing.reopen || backing.store.durability !== 'persistent')
        return context.skip();

      const runtime = reviews();

      await runtime.host.adopt(Customer, 'mothlight');

      const page = await runtime.host.activity.feed.read();

      await runtime.close();

      const reopened = await backing.reopen();
      const restarted = reviews({ store: reopened });

      crm.set('second', {
        state: 'present',
        name: 'Second',
        portfolio: 'north',
      });
      await restarted.host.adopt(Customer, 'second');

      const next = await restarted.host.activity.feed.read({
        cursor: page.nextCursor,
      });

      expect(next.entries.map((entry) => entry.kind)).toEqual(['adopted']);
      expect((await restarted.host.activity.feed.read()).entries[0]).toEqual(
        page.entries[0],
      );
      await restarted.close();
      await reopened.close();
    });
  });
}

/** Lineage records stable property IDs per evidence status, never values. */
export function lineageContract(
  name: string,
  open: () => Promise<{ store: ObservationStore; close(): Promise<void> }>,
) {
  describe(name, () => {
    it('distinguishes returned and forbidden properties after authorization', async () => {
      const { store, close } = await open();
      const { Customer, customers, customerGraph, employee, finance } =
        createCustomerGraph();
      const runtime = createRuntime({
        graph: customerGraph,
        graphId: randomUUID(),
        store,
        bindings: [
          bind(customers, {
            providerAccountId: 'example-account',
            connectionId: 'crm',
            resourceId: 'records',
            connector: {
              identify: async () => 'example-account',
              fetch: async (id) => ({
                providerAccountId: 'example-account',
                state: 'present',
                record: {
                  id,
                  display_name: 'Ada',
                  portfolio: 'portfolio_north',
                  revenue: 10,
                },
              }),
            },
          }),
        ],
      });

      try {
        const id = await runtime.host.adopt(Customer, '1');

        for (const principal of [employee, finance])
          await runtime.as(principal).objects.Customer.query({
            select: ['name', 'revenue'],
            evidence: 'compact',
          });

        let queries: readonly Operation[] = [];

        await vi.waitFor(async () => {
          queries = (
            await runtime.host.activity.operations.list({
              filter: { kinds: ['query'] },
            })
          ).entries;
          expect(queries).toHaveLength(2);
        });

        const byActor = Object.fromEntries(
          queries.map((operation) => [operation.actor.id, operation]),
        );

        expect(byActor.fin).toMatchObject({
          definitionId: Customer.id,
          outcome: { status: 'ok' },
          details: { hasMore: false },
          objects: [
            {
              objectId: id,
              role: 'returned',
              returned: ['business.customer.name', 'business.customer.revenue'],
              forbidden: [],
            },
          ],
        });
        expect(byActor.ana!.objects).toEqual([
          {
            objectDefinitionId: Customer.id,
            objectId: id,
            role: 'returned',
            returned: ['business.customer.name'],
            forbidden: ['business.customer.revenue'],
            unavailable: [],
          },
        ]);
        expect(JSON.stringify(queries)).not.toContain('Ada');
      } finally {
        await runtime.close();
        await close();
      }
    });
  });
}
