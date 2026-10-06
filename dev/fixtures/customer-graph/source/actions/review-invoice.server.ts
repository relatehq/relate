import { implementAction } from './implement-action.server.js';
import { ReviewInvoice } from './review-invoice.js';

export const reviewInvoice = implementAction(
  ReviewInvoice,
  async ({ actor, input, objects }) => {
    // The second lookup's ID is only known after the first lookup finishes.
    const invoice = await objects.Invoice.get(input.invoice.id, {
      select: ['customer'],
    });

    if (invoice.status !== 'ok' || invoice.data.customer === undefined)
      throw new Error('Invoice customer unavailable');

    const customer = await objects.Customer.get(invoice.data.customer, {
      select: ['name'],
    });

    if (customer.status !== 'ok' || customer.data.name === undefined)
      throw new Error('Customer unavailable');

    const review = await objects.AccountReview.create({
      customer: customer.id,
      author: actor.id,
      note: `${customer.data.name}: ${input.note}`,
    });

    return { reviewId: review.id };
  },
);
