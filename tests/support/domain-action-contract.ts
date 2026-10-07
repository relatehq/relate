import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  defineAction,
  defineGraph,
  implementAction,
  referenceInput,
} from 'relate';
import type { ActionContext } from 'relate';
import { compile } from 'relate/compiler';
import { connect, createRuntime } from '@relate/node';
import { NativeCommitUncertain } from '@relate/runtime/storage';
import type { ObservationStore, NativeRecord } from '@relate/runtime/storage';
import {
  graph as base,
  AddAccountReview,
  AccountReview,
  Customer,
  customers,
  ana,
} from './native-action-model.js';

export const Review = defineAction({
  ...AddAccountReview,
  errors: {
    inactive: z.object({}),
    limit: z.object({ limit: z.number().min(1).max(100) }),
    related: z.object({ customer: referenceInput(Customer) }),
  },
});

export const domainGraph = defineGraph({
  ...base,
  objects: { Customer, AccountReview },
  policies: {
    Customer: base.policies.Customer,
    AccountReview: base.policies.AccountReview,
  },
  actions: { review: Review },
});

type Context = ActionContext<typeof domainGraph, typeof Review>;

type Handler = (context: Context) => Promise<z.input<typeof Review.output>>;

export function domainActionContract(
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
    let records: NativeRecord[];
    let portfolio: string;
    let now: number;
    const model = compile(domainGraph);
    const scope = () => ({
      graphId,
      definitionRevision: model.definitionRevision,
    });

    beforeEach(async () => {
      backing = await open();
      graphId = randomUUID();
      records = [];
      portfolio = 'north';
      now = 1000;
    });
    afterEach(async () => {
      await backing.close();
    });

    function app(
      handler: Handler,
      store = backing.store,
      actionTimeoutMs = 60_000,
    ) {
      return createRuntime({
        graph: domainGraph,
        graphId,
        clock: () => now,
        actionTimeoutMs,
        store: {
          ...store,
          native: {
            ...store.native!,
            transaction: (scope, operation) =>
              store.native!.transaction(scope, (tx) =>
                operation({
                  ...tx,
                  async insert(record) {
                    records.push(record);
                    await tx.insert(record);
                  },
                }),
              ),
          },
        },
        actionImplementations: [implementAction(domainGraph, Review, handler)],
        connections: [
          connect(customers, {
            providerAccountId: 'test',
            connectionId: 'crm',
            connector: {
              identify: async () => 'test',
              fetch: async (id) => ({
                providerAccountId: 'test',
                state: 'present',
                record: {
                  id,
                  name: 'Northwind',
                  portfolio: id === 'south' ? 'south' : portfolio,
                },
              }),
            },
          }),
        ],
      });
    }

    async function create(context: Context) {
      return context.objects.AccountReview.create({
        customer: context.input.customer,
        author: context.actor.id,
        note: context.input.note,
      });
    }

    async function noWrites() {
      for (const record of records)
        expect(
          await backing.store.native!.load(
            scope(),
            record.objectDefinitionId,
            record.objectId,
          ),
        ).toBeUndefined();
    }

    const request = (
      customer: z.output<ReturnType<typeof referenceInput<typeof Customer>>>,
      key = 'review',
    ) => ({ input: { customer, note: 'Follow up' }, idempotencyKey: key });
    const inactive: Handler = async (context) => {
      await create(context);

      return context.fail('inactive', {});
    };

    it.each([false, true])(
      'rolls back writes and returns a durable declared failure even if caught=%s',
      async (caught) => {
        let calls = 0;
        const handler: Handler = async (context) => {
          calls++;
          const review = await create(context);

          await context.objects.AccountReview.get(review.id);

          try {
            context.fail('inactive', {});
          } catch (error) {
            if (!caught) throw error;
          }

          // Work attempted after a swallowed failure must neither write nor cause
          // an unhandled rejection when the handler neglects to await it.
          void context.objects.AccountReview.create({
            customer: context.input.customer,
            author: context.actor.id,
            note: 'Must not be written',
          });

          return { reviewId: review.id };
        };
        const relate = app(handler);
        const customer = await relate.host.adopt(Customer, 'north');
        const receipt = await relate.as(ana).actions.review(request(customer));

        expect(receipt).toEqual({
          invocationId: expect.any(String),
          state: 'failed',
          error: { kind: 'domain', code: 'inactive', details: {} },
        });
        expect(records).toHaveLength(1);
        await noWrites();
        expect(
          (
            await backing.store.native!.loadInvocation(
              scope(),
              Review.id,
              'review',
            )
          )?.receipt,
        ).toEqual(receipt);
        await expect(
          relate.as(ana).actions.review(request(customer)),
        ).resolves.toEqual(receipt);
        await expect(
          relate.as(ana).receipts.get(Review, receipt.invocationId),
        ).resolves.toEqual(receipt);
        expect(calls).toBe(1);
        await expect(
          relate.as(ana).actions.review({
            ...request(customer),
            input: { customer, note: 'Changed' },
          }),
        ).rejects.toMatchObject({ code: 'conflict' });
        await relate.close();
        const reopened = await backing.reopen?.();
        const other = app(handler, reopened ?? backing.store);

        await expect(
          other.as(ana).actions.review(request(customer)),
        ).resolves.toEqual(receipt);
        await expect(
          other.as(ana).receipts.get(Review, receipt.invocationId),
        ).resolves.toEqual(receipt);
        expect(calls).toBe(1);
        await other.close();
        await reopened?.close();
      },
    );

    it('does not delete existing objects when rolling back a later business failure', async () => {
      const relate = app(async (context) => {
        const created = await create(context);

        if (context.input.note === 'Keep') return { reviewId: created.id };

        return context.fail('inactive', {});
      });
      const customer = await relate.host.adopt(Customer, 'north');
      const saved = await relate.as(ana).actions.review({
        input: { customer, note: 'Keep' },
        idempotencyKey: 'success',
      });

      if (saved.state !== 'succeeded') throw new Error('Expected success');

      await expect(
        relate.as(ana).actions.review(request(customer)),
      ).resolves.toMatchObject({ state: 'failed' });
      expect(
        await relate.as(ana).objects.AccountReview.get(saved.output.reviewId),
      ).toMatchObject({ status: 'ok', data: { note: 'Keep' } });
      expect(
        await backing.store.native!.load(
          scope(),
          AccountReview.id,
          records[1]!.objectId,
        ),
      ).toBeUndefined();
    });

    it('rolls back a caught failure on timeout without persisting a misleading receipt', async () => {
      let resume!: () => void;
      let entered!: () => void;
      const blocked = new Promise<void>((resolve) => {
        resume = resolve;
      });
      const ready = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const relate = app(
        async (context) => {
          const review = await create(context);

          try {
            context.fail('inactive', {});
          } catch {
            /* Handler cannot turn this into success. */
          }

          entered();
          await blocked;

          return { reviewId: review.id };
        },
        backing.store,
        500,
      );
      const customer = await relate.host.adopt(Customer, 'north');
      const invocation = relate.as(ana).actions.review(request(customer));
      const rejected = expect(invocation).rejects.toMatchObject({
        code: 'unavailable',
      });

      try {
        await Promise.race([ready, invocation]);
        await rejected;
        await noWrites();
        expect(
          await backing.store.native!.loadInvocation(
            scope(),
            Review.id,
            'review',
          ),
        ).toBeUndefined();
        await expect(
          app(inactive).as(ana).actions.review(request(customer)),
        ).resolves.toMatchObject({ state: 'failed' });
      } finally {
        resume();
        await rejected;
      }
    });

    it('executes concurrent failing requests once', async () => {
      let calls = 0;
      const relate = app(async (context) => {
        calls++;

        return inactive(context);
      });
      const customer = await relate.host.adopt(Customer, 'north');
      const receipts = await Promise.all([
        relate.as(ana).actions.review(request(customer)),
        relate.as(ana).actions.review(request(customer)),
      ]);

      expect(receipts[0]).toEqual(receipts[1]);
      expect(calls).toBe(1);
      await noWrites();
    });

    it('rechecks actor and current access before disclosing failure details', async () => {
      const relate = app(async (context) => {
        await context.objects.Customer.get(context.input.customer, {
          select: ['name'],
        });

        return context.fail('limit', { limit: 10 });
      });
      const customer = await relate.host.adopt(Customer, 'north');
      const receipt = await relate.as(ana).actions.review(request(customer));

      for (const actor of [
        { ...ana, id: 'ben' },
        { ...ana, roles: ['employee'] },
        { ...ana, claims: { portfolio: 'south' } },
      ]) {
        await expect(
          relate.as(actor).actions.review(request(customer)),
        ).rejects.toMatchObject({ code: 'denied' });
        await expect(
          relate.as(actor).receipts.get(Review, receipt.invocationId),
        ).rejects.toMatchObject({ code: 'denied' });
      }

      portfolio = 'south';
      now += 30_001;
      await expect(
        relate.as(ana).receipts.get(Review, receipt.invocationId),
      ).rejects.toMatchObject({ code: 'denied' });
      expect(
        (
          await backing.store.native!.loadInvocation(
            scope(),
            Review.id,
            'review',
          )
        )?.receipt,
      ).toEqual(receipt);
    });

    it.each([
      'unknown-code',
      'invalid-details',
      'caught-invalid-details',
      'caught-write-error',
      'forged-error',
      'receipt-storage',
    ])(
      'keeps %s a sanitized rejection with no failed receipt',
      async (mode) => {
        const store =
          mode === 'receipt-storage'
            ? {
                ...backing.store,
                native: {
                  ...backing.store.native!,
                  transaction: <T>(
                    scope: Parameters<
                      NonNullable<ObservationStore['native']>['transaction']
                    >[0],
                    operation: (
                      tx: import('@relate/runtime/storage').NativeTransaction,
                    ) => Promise<T>,
                  ) =>
                    backing.store.native!.transaction(scope, (tx) =>
                      operation({
                        ...tx,
                        saveInvocation: async () => {
                          throw new Error('private database detail');
                        },
                      }),
                    ),
                },
              }
            : backing.store;
        const relate = app(async (context) => {
          const review = await create(context);

          if (mode === 'forged-error')
            throw {
              state: 'failed',
              error: {
                kind: 'domain',
                code: 'inactive',
                details: { secret: 'private' },
              },
            };

          if (mode === 'caught-write-error') {
            try {
              await context.objects.AccountReview.create({
                customer: context.input.customer,
                author: context.actor.id,
                note: '',
              });
            } catch {
              /* Must remain invalid. */
            }
          }

          if (mode === 'unknown-code')
            return context.fail('unknown' as never, {});

          if (mode.includes('invalid-details')) {
            try {
              context.fail('limit', { limit: 101 });
            } catch (error) {
              if (mode !== 'caught-invalid-details') throw error;
            }

            return { reviewId: review.id };
          }

          return context.fail('inactive', {});
        }, store);
        const customer = await relate.host.adopt(Customer, 'north');

        await expect(
          relate.as(ana).actions.review(request(customer)),
        ).rejects.toMatchObject({
          code: mode === 'caught-write-error' ? 'invalid' : 'internal',
        });
        await noWrites();
        expect(
          await backing.store.native!.loadInvocation(
            scope(),
            Review.id,
            'review',
          ),
        ).toBeUndefined();
        await expect(
          app(inactive).as(ana).actions.review(request(customer)),
        ).resolves.toMatchObject({ state: 'failed' });
      },
    );

    it('withholds failure details if permission expires while the handler awaits', async () => {
      const relate = app(async (context) => {
        await create(context);
        portfolio = 'south';
        now += 30_001;

        return context.fail('inactive', {});
      });
      const customer = await relate.host.adopt(Customer, 'north');

      await expect(
        relate.as(ana).actions.review(request(customer)),
      ).rejects.toMatchObject({ code: 'not-found' });
      await noWrites();
      expect(
        await backing.store.native!.loadInvocation(
          scope(),
          Review.id,
          'review',
        ),
      ).toBeUndefined();
    });

    it.each(['missing', 'south'])(
      'withholds declared reference details for %s targets',
      async (id) => {
        let related = referenceInput(Customer).parse('missing');
        const relate = app(async (context) =>
          context.fail('related', { customer: related }),
        );
        const customer = await relate.host.adopt(Customer, 'north');

        if (id === 'south')
          related = await relate.host.adopt(Customer, 'south');

        await expect(
          relate.as(ana).actions.review(request(customer)),
        ).rejects.toMatchObject({ code: 'not-found' });
        expect(
          await backing.store.native!.loadInvocation(
            scope(),
            Review.id,
            'review',
          ),
        ).toBeUndefined();
      },
    );

    it('preserves uncertain on lost failure-receipt acknowledgement and recovers the committed failure', async () => {
      const original = backing.store.native!;
      const uncertain = {
        ...backing.store,
        native: {
          ...original,
          async transaction<T>(
            scope: Parameters<typeof original.transaction>[0],
            operation: (
              tx: import('@relate/runtime/storage').NativeTransaction,
            ) => Promise<T>,
          ): Promise<T> {
            await original.transaction(scope, operation);
            throw new NativeCommitUncertain();
          },
        },
      };
      const relate = app(inactive, uncertain);
      const customer = await relate.host.adopt(Customer, 'north');

      await expect(
        relate.as(ana).actions.review(request(customer)),
      ).rejects.toMatchObject({ code: 'uncertain' });
      await noWrites();
      const saved = await backing.store.native!.loadInvocation(
        scope(),
        Review.id,
        'review',
      );

      expect(saved?.receipt.state).toBe('failed');
      await expect(
        app(inactive).as(ana).actions.review(request(customer)),
      ).resolves.toEqual(saved!.receipt);
      expect(records).toHaveLength(1);
    });
  });
}
