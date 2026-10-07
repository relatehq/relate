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
