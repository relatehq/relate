import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { implementAction, referenceInput } from 'relate';
import type { ActionContext, ObjectId } from 'relate';
import { compile } from 'relate/compiler';
import { createRuntime } from '@relate/node';
import { connect } from 'relate';
import { SourceAccessDenied } from 'relate/connectors';
import { ReadError } from '@relate/protocol';
import type { ObservationStore, NativeRecord } from '@relate/runtime/storage';
import {
  NativeCommitUncertain,
  StorageUnavailable,
} from '@relate/runtime/storage';
import {
  graph,
  AddAccountReview,
  AccountReview,
  Customer,
  Invoice,
  customers,
  invoices,
  ana,
  addAccountReview,
} from './native-action-model.js';

type Context = ActionContext<typeof graph, typeof AddAccountReview>;

type Handler = (
  context: Context,
) => ReturnType<typeof addAccountReview.implementation>;

export function nativeActionContract(
  name: string,
  open: () => Promise<{
    store: ObservationStore;
    close(): Promise<void>;
    reopen?(): Promise<ObservationStore & { close(): Promise<void> }>;
  }>,
) {
  describe(name, () => {
    let backing: Awaited<ReturnType<typeof open>>;
    let attempted: NativeRecord[];
    let graphId: string;
    let now: number;
    let sourceDenied: boolean;
    let portfolio: string;
    const model = compile(graph);
    const scope = () => ({
      graphId,
      definitionRevision: model.definitionRevision,
    });

    beforeEach(async () => {
      backing = await open();
      attempted = [];
      graphId = randomUUID();
      now = 10_000;
      sourceDenied = false;
      portfolio = 'north';
    });
    afterEach(async () => {
      await backing?.close();
    });

    function app(
      handler: Handler = addAccountReview.implementation,
      storage = backing.store,
      actionTimeoutMs = 60_000,
    ) {
      if (!storage.native) throw new Error('Native store required');

      const native = storage.native;

      return createRuntime({
        graph,
        graphId,
        clock: () => now,
        actionTimeoutMs,
        store: {
          ...storage,
          native: {
            ...native,
            transaction: (scope, operation) =>
              native.transaction(scope, (transaction) =>
                operation({
                  ...transaction,
                  async insert(record) {
                    attempted.push(record);

                    return transaction.insert(record);
                  },
                }),
              ),
          },
        },
        actionImplementations: [
          implementAction(graph, AddAccountReview, handler),
        ],
        connections: [
          connect(customers, {
            providerAccountId: 'example-account',
            connectionId: 'crm',
            connector: {
              identify: async () => 'example-account',
              async fetch(id) {
                if (sourceDenied) throw new SourceAccessDenied();

                return {
                  providerAccountId: 'example-account',
                  state: 'present',
                  record: {
                    id,
                    name: id === 'northwind' ? 'Northwind' : 'Southbank',
                    portfolio: id === 'northwind' ? portfolio : 'south',
                  },
                };
              },
            },
          }),
          connect(invoices, {
            providerAccountId: 'example-account',
            connectionId: 'billing',
            connector: {
              identify: async () => 'example-account',
              async fetch(id) {
                return {
                  providerAccountId: 'example-account',
                  state: 'present',
                  record: { id },
                };
              },
            },
          }),
        ],
      });
    }

    async function absent(key = 'review') {
      for (const record of attempted)
        expect(
          await backing.store.native!.load(
            scope(),
            record.objectDefinitionId,
            record.objectId,
          ),
        ).toBeUndefined();

      expect(
        await backing.store.native!.loadInvocation(
          scope(),
          AddAccountReview.id,
          key,
        ),
      ).toBeUndefined();
    }

    it('executes the real public action and atomically records a readable review and receipt', async () => {
      const relate = app();
      const customer = await relate.host.adopt(Customer, 'northwind');
      const receipt = await relate.as(ana).actions.addAccountReview({
        input: { customer, note: 'Follow up' },
        idempotencyKey: 'review',
      });

      expect(receipt).toMatchObject({
        state: 'succeeded',
        invocationId: expect.any(String),
        output: { reviewId: expect.any(String) },
      });
      expect(
        await relate
          .as(ana)
          .objects.AccountReview.get(receipt.output.reviewId, {
            evidence: 'full',
          }),
      ).toMatchObject({
        status: 'ok',
        data: {
          id: receipt.output.reviewId,
          customer,
          author: 'ana',
          note: 'Follow up',
        },
        meta: {
          fields: {
            note: {
              source: 'native',
              retentionDurability: backing.store.durability,
            },
          },
        },
      });
      const saved = await backing.store.native!.loadInvocation(
        scope(),
        AddAccountReview.id,
        'review',
      );

      expect(saved?.receipt).toEqual(receipt);
      expect(saved?.actorId).toBe(ana.id);
      expect(attempted).toHaveLength(1);
      const record = await backing.store.native!.load(
        scope(),
        AccountReview.id,
        receipt.output.reviewId,
      );

      expect(record?.values).toEqual({
        'review.customer': customer,
        'review.author': 'ana',
        'review.note': 'Follow up',
      });
      await relate.close();
      const reconnected = backing.reopen
        ? (await backing.close(), await backing.reopen())
        : undefined;
      const reopened = app(undefined, reconnected ?? backing.store);

      await expect(
        reopened.as(ana).receipts.get(AddAccountReview, receipt.invocationId),
      ).resolves.toEqual(receipt);
      await expect(
        reopened.as(ana).actions.addAccountReview({
          input: { note: 'Follow up', customer },
          idempotencyKey: 'review',
        }),
      ).resolves.toEqual(receipt);
      expect(attempted).toHaveLength(1);

      if (reconnected)
        expect(
          (
            await reconnected.native!.loadInvocation(
              scope(),
              AddAccountReview.id,
              'review',
            )
          )?.receipt,
        ).toEqual(receipt);

      expect(
        await reopened
          .as(ana)
          .objects.AccountReview.get(receipt.output.reviewId),
      ).toMatchObject({ status: 'ok', data: { note: 'Follow up' } });
      await reopened.close();
      await reconnected?.close();
    });
    it.each(['', 'x'.repeat(4001)])(
      'enforces note limits on input and native creation (%#. case)',
      async (note) => {
        let calls = 0;
        const relate = app(async (context) => {
          calls++;

          return addAccountReview.implementation(context);
        });
        const customer = await relate.host.adopt(Customer, 'northwind');

        await expect(
          relate.as(ana).actions.addAccountReview({
            input: { customer, note },
            idempotencyKey: 'review',
          }),
        ).rejects.toMatchObject({ code: 'invalid' });
        expect(calls).toBe(0);
        const bypass = app(async (context) => {
          await addAccountReview.implementation(context);

          return addAccountReview.implementation({
            ...context,
            input: { ...context.input, note },
          });
        });

        await expect(
          bypass.as(ana).actions.addAccountReview({
            input: { customer, note: 'Valid input' },
            idempotencyKey: 'review',
          }),
        ).rejects.toMatchObject({ code: 'invalid' });
        expect(attempted).toHaveLength(1);
        await absent();
      },
    );
    it.each(['x', 'x'.repeat(4000), '😀'.repeat(4000)])(
      'accepts the note boundaries (%#. case)',
      async (note) => {
        const relate = app();
        const customer = await relate.host.adopt(Customer, 'northwind');
        const receipt = await relate.as(ana).actions.addAccountReview({
          input: { customer, note },
          idempotencyKey: 'review',
        });

        expect(
          await relate
            .as(ana)
            .objects.AccountReview.get(receipt.output.reviewId),
        ).toMatchObject({ status: 'ok', data: { note } });
      },
    );
    it.each(['missing', 'southbank'])(
      'uses not-found for a %s input reference, matching object reads',
      async (sourceId) => {
        let calls = 0;
        const relate = app(async (context) => {
          calls++;

          return addAccountReview.implementation(context);
        });
        const customer =
          sourceId === 'missing'
            ? referenceInput(Customer).parse('missing')
            : await relate.host.adopt(Customer, sourceId);

        expect(await relate.as(ana).objects.Customer.get(customer)).toEqual({
          status: 'not-found',
        });
        await expect(
          relate.as(ana).actions.addAccountReview({
            input: { customer, note: 'Review' },
            idempotencyKey: 'review',
          }),
        ).rejects.toMatchObject({ code: 'not-found', message: 'not-found' });
        expect(calls).toBe(0);
        await absent();
      },
    );
    it('rejects action-role denial and invalid input before handler entry', async () => {
      let calls = 0;
      const relate = app(async (context) => {
        calls++;

        return addAccountReview.implementation(context);
      });
      const customer = await relate.host.adopt(Customer, 'northwind');

      await expect(
        relate
          .as({ ...ana, roles: ['employee', 'finance'] })
          .actions.addAccountReview({
            input: { customer, note: 'No' },
            idempotencyKey: 'review',
          }),
      ).rejects.toMatchObject({ code: 'denied' });
      await expect(
        relate.as(ana).actions.addAccountReview({
          input: { customer, note: 3 } as never,
          idempotencyKey: 'review',
        }),
      ).rejects.toMatchObject({ code: 'invalid' });
      expect(calls).toBe(0);
      await absent();
    });
    it.each(['invoice', 'unknown', 'southbank', 'wrong-author'])(
      'enforces %s at create without an author pre-read, and rolls back an earlier valid write',
      async (invalid) => {
        let candidate: ObjectId<typeof Customer.id>;
        const relate = app(async ({ actor, input, objects }) => {
          await objects.AccountReview.create({
            customer: input.customer,
            author: actor.id,
            note: 'First write',
          });
          const review = await objects.AccountReview.create({
            customer: candidate,
            author: invalid === 'wrong-author' ? 'someone-else' : actor.id,
            note: input.note,
          });

          return { reviewId: review.id };
        });
        const customer = await relate.host.adopt(Customer, 'northwind');

        candidate = referenceInput(Customer).parse(
          invalid === 'invoice'
            ? await relate.host.adopt(Invoice, 'invoice-1')
            : invalid === 'unknown'
              ? 'missing-customer'
              : invalid === 'southbank'
                ? await relate.host.adopt(Customer, 'southbank')
                : customer,
        );
        await expect(
          relate.as(ana).actions.addAccountReview({
            input: { customer, note: 'Second write' },
            idempotencyKey: 'review',
          }),
        ).rejects.toMatchObject({
          code: invalid === 'wrong-author' ? 'denied' : 'not-found',
        });
        expect(attempted).toHaveLength(1);
        await absent();
      },
    );
    it('checks reference input membership before invoking the implementation', async () => {
      let called = false;
      const relate = app(async (context) => {
        called = true;

        return addAccountReview.implementation(context);
      });
      const invoice = await relate.host.adopt(Invoice, 'invoice-1');

      await expect(
        relate.as(ana).actions.addAccountReview({
          input: {
            customer: referenceInput(Customer).parse(invoice),
            note: 'Wrong type',
          },
          idempotencyKey: 'review',
        }),
      ).rejects.toMatchObject({ code: 'not-found' });
      expect(called).toBe(false);
      await absent();
    });
    it.each(['throw', 'invalid-output', 'caught-write-error'])(
      'rolls back all native writes on %s',
      async (mode) => {
        const relate = app(async ({ actor, input, objects }) => {
          const review = await objects.AccountReview.create({
            customer: input.customer,
            author: actor.id,
            note: input.note,
          });

          if (mode === 'throw') throw new Error('private provider credentials');

          if (mode === 'invalid-output') return { reviewId: 42 } as never;

          try {
            await objects.AccountReview.create({
              customer: input.customer,
              author: 'other',
              note: 'Denied',
            });
          } catch {
            /* Cannot turn an aborted write into success. */
          }

          return { reviewId: review.id };
        });
        const customer = await relate.host.adopt(Customer, 'northwind');

        await expect(
          relate.as(ana).actions.addAccountReview({
            input: { customer, note: 'Rollback' },
            idempotencyKey: 'review',
          }),
        ).rejects.toSatisfy(
          (error: Error) =>
            error.name === 'ActionError' && !error.message.includes('private'),
        );
        expect(attempted).toHaveLength(1);
        await absent();
      },
    );
    it('reads its own native writes without exposing them to another invocation before commit', async () => {
      let signal!: () => void;
      let resume!: () => void;
      const ready = new Promise<void>((resolve) => {
        signal = resolve;
      });
      const barrier = new Promise<void>((resolve) => {
        resume = resolve;
      });
      let reviewId!: ObjectId<typeof AccountReview.id>;
      const relate = app(async ({ input, actor, objects }) => {
        const review = await objects.AccountReview.create({
          customer: input.customer,
          author: actor.id,
          note: input.note,
        });

        reviewId = review.id;
        expect(await objects.AccountReview.get(review.id)).toMatchObject({
          status: 'ok',
          data: { note: 'Private until commit' },
        });
        signal();
        await barrier;

        return { reviewId: review.id };
      });
      const customer = await relate.host.adopt(Customer, 'northwind');
      const pending = relate.as(ana).actions.addAccountReview({
        input: { customer, note: 'Private until commit' },
        idempotencyKey: 'review',
      });

      await ready;

      try {
        expect(
          await relate.as(ana).objects.AccountReview.get(reviewId),
        ).toEqual({ status: 'not-found' });
      } finally {
        resume();
      }

      await pending;
      expect(
        await relate.as(ana).objects.AccountReview.get(reviewId),
      ).toMatchObject({ status: 'ok' });
    });
    it.each(['portfolio', 'source-denial'])(
      'revalidates permission after action awaits and rejects %s',
      async (change) => {
        const relate = app(async (context) => {
          const result = await addAccountReview.implementation(context);

          if (change === 'portfolio') portfolio = 'south';
          else sourceDenied = true;

          now += 31_000;

          return result;
        });
        const customer = await relate.host.adopt(Customer, 'northwind');

        await expect(
          relate.as(ana).actions.addAccountReview({
            input: { customer, note: 'Recheck' },
            idempotencyKey: 'review',
          }),
        ).rejects.toMatchObject({ code: 'not-found' });
        await absent();
      },
    );
    it('recovers concurrent identical requests without executing twice and rejects changed input', async () => {
      let calls = 0;
      const handler: Handler = async (context) => {
        calls++;

        return addAccountReview.implementation(context);
      };
      const relate = app(handler);
      const customer = await relate.host.adopt(Customer, 'northwind');
      const request = {
        input: { customer, note: 'Once' },
        idempotencyKey: 'review',
      };
      const results = await Promise.all([
        relate.as(ana).actions.addAccountReview(request),
        app(handler).as(ana).actions.addAccountReview(request),
      ]);

      expect(results[1]).toEqual(results[0]);
      await expect(
        relate.as(ana).actions.addAccountReview({
          ...request,
          input: { customer, note: 'Changed' },
        }),
      ).rejects.toMatchObject({ code: 'conflict' });
      expect(calls).toBe(1);
      expect(attempted).toHaveLength(1);
    });
    it('binds replay and lookup to the originating actor and current role and portfolio access', async () => {
      const relate = app();
      const customer = await relate.host.adopt(Customer, 'northwind');
      const request = {
        input: { customer, note: 'Private review' },
        idempotencyKey: 'owned',
      };
      const receipt = await relate.as(ana).actions.addAccountReview(request);

      for (const principal of [
        { ...ana, id: 'ben' },
        { ...ana, roles: ['employee'] },
        { ...ana, claims: { portfolio: 'south' } },
      ]) {
        const caller = relate.as(principal);

        await expect(
          caller.actions.addAccountReview(request),
        ).rejects.toMatchObject({ code: 'denied' });
        await expect(
          caller.receipts.get(AddAccountReview, receipt.invocationId),
        ).rejects.toMatchObject({ code: 'denied' });
      }

      await expect(
        relate.as({ ...ana, id: 'ben' }).actions.addAccountReview({
          ...request,
          input: { customer, note: 'Different' },
        }),
      ).rejects.toMatchObject({ code: 'denied' });
      await expect(
        relate.as(ana).receipts.get(AddAccountReview, 'missing'),
      ).rejects.toMatchObject({ code: 'denied' });
      await expect(
        relate
          .as(ana)
          .receipts.get({ ...AddAccountReview }, receipt.invocationId),
      ).rejects.toMatchObject({ code: 'denied' });
      await expect(
        relate.as(ana).receipts.get(AddAccountReview, receipt.invocationId),
      ).resolves.toEqual(receipt);
      await expect(
        relate.as(ana).actions.addAccountReview(request),
      ).resolves.toEqual(receipt);
      expect(attempted).toHaveLength(1);

      // Current source evidence, rather than the originally saved claims, decides access.
      portfolio = 'south';
      now += 30_001;
      await expect(
        relate.as(ana).receipts.get(AddAccountReview, receipt.invocationId),
      ).rejects.toMatchObject({ code: 'denied' });
      await expect(
        relate.as(ana).actions.addAccountReview(request),
      ).rejects.toMatchObject({ code: 'denied' });
      expect(
        (
          await backing.store.native!.loadInvocation(
            scope(),
            AddAccountReview.id,
            'owned',
          )
        )?.receipt,
      ).toEqual(receipt);

      portfolio = 'north';
      now += 30_001;
      await expect(
        relate.as(ana).receipts.get(AddAccountReview, receipt.invocationId),
      ).resolves.toEqual(receipt);
      const originalGraph = graphId;

      graphId = randomUUID();
      await expect(
        app().as(ana).receipts.get(AddAccountReview, receipt.invocationId),
      ).rejects.toMatchObject({ code: 'denied' });
      graphId = originalGraph;
    });
    it('does not share a concurrently claimed invocation with another actor', async () => {
      const relate = app();
      const customer = await relate.host.adopt(Customer, 'northwind');
      const request = {
        input: { customer, note: 'One author' },
        idempotencyKey: 'race',
      };
      const results = await Promise.allSettled([
        relate.as(ana).actions.addAccountReview(request),
        app()
          .as({ ...ana, id: 'ben' })
          .actions.addAccountReview(request),
      ]);

      expect(
        results.filter((result) => result.status === 'fulfilled'),
      ).toHaveLength(1);
      expect(
        results.filter((result) => result.status === 'rejected'),
      ).toMatchObject([{ reason: { code: 'denied' } }]);
      expect(attempted).toHaveLength(1);
      const saved = await backing.store.native!.loadInvocation(
        scope(),
        AddAccountReview.id,
        'race',
      );

      expect(saved?.actorId).toBe(attempted[0]!.values['review.author']);
    });
    it('executes more simultaneous actions than the native connection pool without starving source reads', async () => {
      const relate = app();
      const customer = await relate.host.adopt(Customer, 'northwind');
      const receipts = await Promise.all(
        Array.from({ length: 8 }, (_, index) =>
          relate.as(ana).actions.addAccountReview({
            input: { customer, note: `Review ${index}` },
            idempotencyKey: `parallel-${index}`,
          }),
        ),
      );

      expect(
        new Set(receipts.map((receipt) => receipt.output.reviewId)).size,
      ).toBe(8);

      for (const [index, receipt] of receipts.entries())
        expect(
          (
            await backing.store.native!.loadInvocation(
              scope(),
              AddAccountReview.id,
              `parallel-${index}`,
            )
          )?.receipt,
        ).toEqual(receipt);
    });
    it('withholds native reads when the caller loses portfolio access', async () => {
      const relate = app();
      const customer = await relate.host.adopt(Customer, 'northwind');
      const receipt = await relate.as(ana).actions.addAccountReview({
        input: { customer, note: 'Private' },
        idempotencyKey: 'review',
      });

      expect(
        await relate
          .as({ ...ana, claims: { portfolio: 'south' } })
          .objects.AccountReview.get(receipt.output.reviewId),
      ).toEqual({ status: 'not-found' });
    });
    it('sanitizes storage failures during native reads', async () => {
      const relate = app();
      const customer = await relate.host.adopt(Customer, 'northwind');
      const receipt = await relate.as(ana).actions.addAccountReview({
        input: { customer, note: 'Saved' },
        idempotencyKey: 'review',
      });
      const broken = app(undefined, {
        ...backing.store,
        native: {
          ...backing.store.native!,
          async load() {
            throw new Error('private database detail');
          },
        },
      });

      await expect(
        broken.as(ana).objects.AccountReview.get(receipt.output.reviewId),
      ).rejects.toMatchObject({
        name: 'ReadError',
        code: 'unavailable',
        message: 'unavailable',
      });
    });
    it('rolls back even when a caught object-operation rejection has no error value', async () => {
      const native = backing.store.native!;
      const broken: ObservationStore = {
        ...backing.store,
        native: {
          ...native,
          transaction: (scope, operation) =>
            native.transaction(scope, (transaction) =>
              operation({
                ...transaction,
                async insert(record) {
                  await transaction.insert(record);
                  throw undefined;
                },
              }),
            ),
        },
      };
      const relate = app(async ({ actor, input, objects }) => {
        try {
          await objects.AccountReview.create({
            customer: input.customer,
            author: actor.id,
            note: input.note,
          });
        } catch {
          /* Still aborts. */
        }

        return { reviewId: referenceInput(AccountReview).parse('invented') };
      }, broken);
      const customer = await relate.host.adopt(Customer, 'northwind');

      await expect(
        relate.as(ana).actions.addAccountReview({
          input: { customer, note: 'Abort' },
          idempotencyKey: 'review',
        }),
      ).rejects.toMatchObject({ name: 'ActionError', code: 'internal' });
      expect(attempted).toHaveLength(1);
      await absent();
    });
    it('rolls back native effects when saving their receipt fails', async () => {
      const original = backing.store.native!;
      const store: ObservationStore = {
        ...backing.store,
        native: {
          ...original,
          transaction: (scope, operation) =>
            original.transaction(scope, (transaction) =>
              operation({
                ...transaction,
                async saveInvocation() {
                  throw new Error('storage failure');
                },
              }),
            ),
        },
      };
      const relate = app(undefined, store);
      const customer = await relate.host.adopt(Customer, 'northwind');

      await expect(
        relate.as(ana).actions.addAccountReview({
          input: { customer, note: 'Atomic' },
          idempotencyKey: 'review',
        }),
      ).rejects.toMatchObject({ code: 'internal' });
      expect(attempted).toHaveLength(1);
      await absent();
    });
    it.each([
      { error: new ReadError('unavailable'), code: 'unavailable' },
      {
        error: new StorageUnavailable({
          cause: new Error('private database details'),
        }),
        code: 'unavailable',
      },
      { error: new Error('private handler details'), code: 'internal' },
    ])(
      'sanitizes $error.name as $code and allows retry after rollback',
      async ({ error, code }) => {
        const relate = app(async (context) => {
          await addAccountReview.implementation(context);
          throw error;
        });
        const customer = await relate.host.adopt(Customer, 'northwind');
        const request = {
          input: { customer, note: 'Retry safely' },
          idempotencyKey: 'review',
        };

        const invocation = relate.as(ana).actions.addAccountReview(request);

        await expect(invocation).rejects.toMatchObject({
          name: 'ActionError',
          code,
          message: code,
        });
        await expect(invocation).rejects.not.toHaveProperty('cause');
        expect(attempted).toHaveLength(1);
        await absent();
        await expect(
          app().as(ana).actions.addAccountReview(request),
        ).resolves.toMatchObject({ state: 'succeeded' });
      },
    );
    it('maps an object read outage after a native insert to unavailable and rolls back', async () => {
      let outage = false;
      const relate = app(
        async (context) => {
          const output = await addAccountReview.implementation(context);

          outage = true;
          await context.objects.Customer.get(context.input.customer);

          return output;
        },
        {
          ...backing.store,
          async load(scope, id) {
            if (outage) throw new Error('private connection details');

            return backing.store.load(scope, id);
          },
        },
      );
      const customer = await relate.host.adopt(Customer, 'northwind');

      await expect(
        relate.as(ana).actions.addAccountReview({
          input: { customer, note: 'Read outage' },
          idempotencyKey: 'review',
        }),
      ).rejects.toMatchObject({ name: 'ActionError', code: 'unavailable' });
      expect(attempted).toHaveLength(1);
      await absent();
    });
    it('maps unavailable installation before opening a native transaction', async () => {
      const customer = await app().host.adopt(Customer, 'northwind');
      const relate = app(undefined, {
        ...backing.store,
        async install() {
          throw new StorageUnavailable();
        },
      });

      await expect(
        relate.as(ana).actions.addAccountReview({
          input: { customer, note: 'Unavailable' },
          idempotencyKey: 'review',
        }),
      ).rejects.toMatchObject({ name: 'ActionError', code: 'unavailable' });
      expect(attempted).toHaveLength(0);
      await absent();
    });
    it('expires a suspended handler, releases its graph/key, and rejects writes when it resumes', async () => {
      let resume!: () => void;
      let entered!: () => void;
      let finished!: () => void;
      let lateError: unknown;
      const blocked = new Promise<void>((resolve) => {
        resume = resolve;
      });
      const ready = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const resumed = new Promise<void>((resolve) => {
        finished = resolve;
      });
      const slow = app(
        async (context) => {
          const output = await addAccountReview.implementation(context);

          entered();
          await blocked;

          try {
            await addAccountReview.implementation(context);
          } catch (error) {
            lateError = error;
          } finally {
            finished();
          }

          return output;
        },
        backing.store,
        500,
      );
      const customer = await slow.host.adopt(Customer, 'northwind');
      const request = {
        input: { customer, note: 'Expired' },
        idempotencyKey: 'review',
      };
      const invocation = slow.as(ana).actions.addAccountReview(request);
      const rejected = expect(invocation).rejects.toMatchObject({
        name: 'ActionError',
        code: 'unavailable',
      });

      try {
        await Promise.race([ready, invocation]);
        const expiredRecord = attempted[0]!;
        // Starts waiting before the first handler times out; it must be able to take the same key.
        const next = app()
          .as(ana)
          .actions.addAccountReview({
            ...request,
            input: { customer, note: 'Recovered' },
          });

        await rejected;
        const receipt = await next;

        expect(
          await backing.store.native!.load(
            scope(),
            AccountReview.id,
            expiredRecord.objectId,
          ),
        ).toBeUndefined();
        expect(receipt.output.reviewId).not.toBe(expiredRecord.objectId);
        expect(
          (
            await backing.store.native!.loadInvocation(
              scope(),
              AddAccountReview.id,
              'review',
            )
          )?.receipt,
        ).toEqual(receipt);
        resume();
        await resumed;
        expect(lateError).toMatchObject({ code: 'unavailable' });
        expect(attempted).toHaveLength(2);
      } finally {
        resume();
        await rejected;
      }
    });
    it('expires while draining an outstanding create and prevents its late insert', async () => {
      let resume!: () => void;
      let waiting!: () => void;
      let blockReads = false;
      let pending: Promise<unknown> | undefined;
      const blocked = new Promise<void>((resolve) => {
        resume = resolve;
      });
      const ready = new Promise<void>((resolve) => {
        waiting = resolve;
      });
      const slow = app(
        async (context) => {
          const output = await addAccountReview.implementation(context);

          blockReads = true;
          pending = context.objects.AccountReview.create({
            customer: context.input.customer,
            author: context.actor.id,
            note: 'Late',
          });
          void pending.catch(() => {});

          return output;
        },
        {
          ...backing.store,
          async load(scope, id) {
            if (blockReads) {
              waiting();
              await blocked;
            }

            return backing.store.load(scope, id);
          },
        },
        500,
      );
      const customer = await slow.host.adopt(Customer, 'northwind');
      const request = {
        input: { customer, note: 'First' },
        idempotencyKey: 'review',
      };
      const invocation = slow.as(ana).actions.addAccountReview(request);
      const rejected = expect(invocation).rejects.toMatchObject({
        code: 'unavailable',
      });

      try {
        await Promise.race([ready, invocation]);
        await rejected;
        expect(attempted).toHaveLength(1);
        await absent();
        resume();
        await expect(pending).rejects.toMatchObject({ code: 'unavailable' });
        expect(attempted).toHaveLength(1);
        await absent();
        await expect(
          app().as(ana).actions.addAccountReview(request),
        ).resolves.toMatchObject({ state: 'succeeded' });
      } finally {
        resume();
        await rejected;
      }
    });
    it('does not report a lost commit acknowledgement as confirmed failure', async () => {
      const original = backing.store.native!;
      const store: ObservationStore = {
        ...backing.store,
        native: {
          ...original,
          async transaction(scope, operation) {
            await original.transaction(scope, operation);
            throw new NativeCommitUncertain();
          },
        },
      };
      const relate = app(undefined, store);
      const customer = await relate.host.adopt(Customer, 'northwind');

      await expect(
        relate.as(ana).actions.addAccountReview({
          input: { customer, note: 'Committed' },
          idempotencyKey: 'review',
        }),
      ).rejects.toMatchObject({ code: 'uncertain' });
      expect(
        (
          await backing.store.native!.loadInvocation(
            scope(),
            AddAccountReview.id,
            'review',
          )
        )?.receipt.state,
      ).toBe('succeeded');
      const saved = await backing.store.native!.loadInvocation(
        scope(),
        AddAccountReview.id,
        'review',
      );

      await expect(
        app()
          .as(ana)
          .actions.addAccountReview({
            input: { customer, note: 'Committed' },
            idempotencyKey: 'review',
          }),
      ).resolves.toEqual(saved!.receipt);
      await expect(
        app()
          .as(ana)
          .receipts.get(AddAccountReview, saved!.receipt.invocationId),
      ).resolves.toEqual(saved!.receipt);
      expect(attempted).toHaveLength(1);
    });
  });
}
