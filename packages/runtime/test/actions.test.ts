import { expect, it } from 'vitest';
import { compile } from 'relate/compiler';
import { createRuntime, createMemoryStore } from '@relate/runtime';
import {
  graph,
  AddAccountReview,
  Customer,
  AccountReview,
  customers,
  invoices,
  ana,
} from '../../../tests/support/native-action-model.js';

it.each(['capability', 'policy'])(
  'enforces native create %s below the typed application facade',
  async (missing) => {
    const model = compile({
      ...graph,
      ...(missing === 'capability'
        ? {
            actions: { addAccountReview: { ...AddAccountReview, creates: [] } },
          }
        : {}),
      ...(missing === 'policy'
        ? {
            policies: {
              ...graph.policies,
              AccountReview: { read: graph.policies.AccountReview.read },
            },
          }
        : {}),
    });
    const store = createMemoryStore();
    let created: string | undefined;
    const runtime = createRuntime({
      model,
      graphId: missing,
      store,
      sources: {
        [customers.id]: {
          connectionId: 'crm',
          authorization: 'shared-service',
          connector: {
            async fetch(id) {
              return {
                state: 'present',
                record: { id, name: 'Northwind', portfolio: 'north' },
              };
            },
          },
        },
        [invoices.id]: {
          connectionId: 'billing',
          authorization: 'shared-service',
          connector: {
            async fetch(id) {
              return { state: 'present', record: { id } };
            },
          },
        },
      },
      actionHandlers: {
        [AddAccountReview.id]: async (context) => {
          const review = await context.create(AccountReview.id, {
            customer: context.input.customer,
            author: context.actor.id,
            note: 'Denied',
          });

          created = review.id;

          return { reviewId: review.id };
        },
      },
    });
    const customer = await runtime.adopt(Customer.id, 'c');

    await expect(
      runtime.invoke(ana, AddAccountReview.id, {
        input: { customer, note: 'n' },
        idempotencyKey: 'k',
      }),
    ).rejects.toMatchObject({ code: 'denied' });
    expect(created).toBeUndefined();
    expect(
      await store.native!.loadInvocation(
        { graphId: missing, definitionRevision: model.definitionRevision },
        AddAccountReview.id,
        'k',
      ),
    ).toBeUndefined();
  },
);
