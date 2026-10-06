/** Compile-time acceptance for native writes and actions, not an executor. */
import { referenceInput } from 'relate';
import type { ObjectId } from 'relate';
import { AccountReview, Customer, Invoice } from '../source/model.js';
import { AddAccountReview } from '../source/actions/add-account-review.js';
import { implementAction } from './target.js';
import { graph } from '../source/graph.js';
import { ana, createFixtureApp } from './setup.js';

const customerId = referenceInput(Customer).parse('c');
const invoiceId = referenceInput(Invoice).parse('i');
const consumer = createFixtureApp().as(ana);

consumer.actions.addAccountReview({
  input: { customer: customerId, note: 'n' },
  idempotencyKey: 'one',
});
consumer.actions.addAccountReview({
  // @ts-expect-error typed invocation rejects another object's ID
  input: { customer: invoiceId, note: 'n' },
  idempotencyKey: 'two',
});
consumer.actions.addAccountReview({
  // @ts-expect-error external strings must be parsed before typed invocation
  input: { customer: 'c', note: 'n' },
  idempotencyKey: 'three',
});

implementAction(graph, AddAccountReview, async ({ input, objects }) => {
  const id: ObjectId<typeof Customer.id> = input.customer;

  objects.Customer.get(id);
  // @ts-expect-error no reference wrapper
  input.customer.id;
  objects.Invoice.query({ where: { customer: id } });
  objects.Invoice.query({
    // @ts-expect-error reference filters use the referenced object's ID
    where: { customer: invoiceId },
  });
  objects.Invoice.query({
    // @ts-expect-error own ID filters use the owner's ID
    where: { id: customerId },
  });
  objects.Invoice.query({
    // @ts-expect-error raw strings do not bypass reference filters
    where: { customer: 'c' },
  });
  await objects.AccountReview.create({
    // @ts-expect-error native references reject another object's ID
    customer: invoiceId,
    author: 'ana',
    note: 'n',
  });
  await objects.AccountReview.create({
    // @ts-expect-error native references reject raw strings
    customer: 'c',
    author: 'ana',
    note: 'n',
  });
  const review = await objects.AccountReview.create({
    customer: id,
    author: 'ana',
    note: 'n',
  });
  const reviewId: ObjectId<typeof AccountReview.id> = review.id;

  // @ts-expect-error creation brands the allocated ID
  objects.Customer.get(review.id);

  return { reviewId };
});

// @ts-expect-error action implementations cannot return another object's ID
implementAction(graph, AddAccountReview, async () => ({ reviewId: invoiceId }));
// @ts-expect-error action implementations cannot return raw IDs
implementAction(graph, AddAccountReview, async () => ({ reviewId: 'r' }));

const receipt = await consumer.actions.addAccountReview({
  input: { customer: customerId, note: 'n' },
  idempotencyKey: 'four',
});

if (receipt.state === 'succeeded') {
  consumer.objects.AccountReview.get(receipt.output.reviewId);
  // @ts-expect-error action result schemas preserve the brand
  consumer.objects.Customer.get(receipt.output.reviewId);
}
