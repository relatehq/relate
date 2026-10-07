import { createRuntime } from '@relate/node';
import { referenceInput } from 'relate';
import type { ObjectId } from 'relate';
import {
  graph,
  addAccountReview,
  ana,
  Customer,
  Invoice,
  AccountReview,
  AddAccountReview,
} from '../../../tests/support/native-action-model.js';

async function caller() {
  const relate = createRuntime({
    graph,
    connections: [],
    actionImplementations: [addAccountReview],
  });
  const consumer = relate.as(ana);
  const customer = referenceInput(Customer).parse('c');
  const receipt = await consumer.actions.addAccountReview({
    input: { customer, note: 'Follow up' },
    idempotencyKey: 'one',
  });
  const id: ObjectId<typeof AccountReview.id> = receipt.output.reviewId;
  const invocationId: string = receipt.invocationId;

  await consumer.objects.AccountReview.get(id);
  // @ts-expect-error action output identity stays typed
  consumer.objects.Customer.get(id);
  consumer.actions.addAccountReview({
    // @ts-expect-error wrong input reference type
    input: { customer: referenceInput(Invoice).parse('i'), note: 'n' },
    idempotencyKey: 'two',
  });
  // @ts-expect-error idempotency key required
  consumer.actions.addAccountReview({ input: { customer, note: 'n' } });
  // @ts-expect-error consumer writes go through actions
  consumer.objects.AccountReview.create({ customer, author: 'ana', note: 'n' });
  // @ts-expect-error host adoption cannot create a native object
  relate.host.adopt(AccountReview, 'provider-key');
  const recovered = await consumer.receipts.get(AddAccountReview, invocationId);
  const recoveredId: ObjectId<typeof AccountReview.id> =
    recovered.output.reviewId;

  // @ts-expect-error lookup requires a registered action definition and invocation ID
  consumer.receipts.get('one');
  // @ts-expect-error an object is not an action contract
  consumer.receipts.get(Customer, invocationId);
  consumer.actions.addAccountReview({
    input: { customer, note: 'n' },
    idempotencyKey: 'bg',
    // @ts-expect-error background execution is not implemented
    mode: 'background',
  });
  void recoveredId;
  void invocationId;
}

void caller;

// Declared business outcomes are inferred by code; actions without errors above stay success-only.
import { defineAction, defineGraph, implementAction } from 'relate';
import { z } from 'zod';
import type { Receipt } from 'relate';

const Review = defineAction({
  ...AddAccountReview,
  errors: {
    inactive: z.object({}),
    limit: z.object({ limit: z.number().min(1).max(100) }),
    related: z.object({ customer: referenceInput(Customer) }),
  },
});
const domainGraph = defineGraph({ ...graph, actions: { review: Review } });

implementAction(domainGraph, Review, async ({ fail }) => {
  // @ts-expect-error unknown business failure code
  fail('typo', {});
  // @ts-expect-error wrong details for this code
  fail('limit', { limit: '100' });
  // @ts-expect-error details are required
  fail('limit');
  const code = Math.random() ? 'inactive' : 'limit';

  // @ts-expect-error a union code must correlate with the declared details
  fail(code, {});

  return fail('inactive', {});
});

implementAction(graph, AddAccountReview, async ({ fail }) => {
  // @ts-expect-error this action declares no business failures
  return fail('inactive', {});
});

function outcome(receipt: Receipt<typeof Review>) {
  if (receipt.state === 'succeeded') {
    const id: ObjectId<typeof AccountReview.id> = receipt.output.reviewId;

    return id;
  }

  // @ts-expect-error failed receipts have no output
  receipt.output;

  if (receipt.error.code === 'limit') {
    const limit: number = receipt.error.details.limit;

    // @ts-expect-error other codes have different details
    receipt.error.details.customer;

    return limit;
  }

  if (receipt.error.code === 'related') {
    const id: ObjectId<typeof Customer.id> = receipt.error.details.customer;

    return id;
  }

  const code: 'inactive' = receipt.error.code;

  return code;
}

void outcome;
