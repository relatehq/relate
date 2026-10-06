import { assertFields } from '@relate/protocol';
import { implementAction } from './implement-action.server.js';
import { ReviewInvoice } from './review-invoice.js';

export const reviewInvoice = implementAction(
  ReviewInvoice,
  async ({ actor, input, objects }) => {
    // The second lookup's ID is only known after the first lookup finishes.
    const invoice = await objects.Invoice.get(input.invoice.id, {
      select: ['customer'],
    });

    assertFields(invoice, ['customer']);

    const customer = await objects.Customer.get(invoice.data.customer, {
      select: ['name'],
    });

    assertFields(customer, ['name']);

    const review = await objects.AccountReview.create({
      customer: customer.id,
      author: actor.id,
      note: `${customer.data.name}: ${input.note}`,
    });

    return { reviewId: review.id };
  },
);
