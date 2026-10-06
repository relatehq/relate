import { implementAction } from './implement-action.server.js';
import { AddAccountReview } from './add-account-review.js';

export const addAccountReview = implementAction(
  AddAccountReview,
  async ({ actor, input, objects }) => {
    const customer = await objects.Customer.get(input.customer, {
      select: ['id'],
    });

    if (customer.status !== 'ok') throw new Error('Customer unavailable');

    const review = await objects.AccountReview.create({
      customer: customer.id,
      author: actor.id,
      note: input.note,
    });

    return { reviewId: review.id };
  },
);
