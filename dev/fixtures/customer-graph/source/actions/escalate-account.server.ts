import { implementAction } from './implement-action.server.js';
import { EscalateAccount } from './escalate-account.js';

export const escalateAccount = implementAction(
  EscalateAccount,
  async ({ actor, input, objects }) => {
    const customer = await objects.Customer.get(input.customer.id, {
      select: ['status'],
    });

    if (customer.status !== 'ok' || customer.data.status === undefined)
      throw new Error('Customer status unavailable');

    // Conditional read: inactive customers never trigger an invoice query.
    if (customer.data.status !== 'active') throw new Error('Inactive customer');

    const review = await objects.AccountReview.create({
      customer: customer.id,
      author: actor.id,
      note: input.note,
    });
    // A native read sees this invocation's earlier native write.
    const written = await objects.AccountReview.get(review.id, {
      select: ['customer'],
    });

    if (written.status !== 'ok' || written.data.customer !== customer.id)
      throw new Error('Review unavailable');

    const taskIds: string[] = [];
    let cursor: string | undefined;

    do {
      // Filtering belongs to the query. Unknown filter evidence must not silently
      // drop matches. Failure later in pagination rolls back all native writes.
      const page = await objects.Invoice.query({
        where: { customer: customer.id, status: 'open' },
        select: ['id'],
        limit: 100,
        ...(cursor ? { cursor } : {}),
      });

      for (const invoice of page.data) {
        if (taskIds.length >= 1_000) throw new Error('Too many invoices');

        const task = await objects.Task.create({
          customer: customer.id,
          review: review.id,
          invoice: invoice.id,
          assignee: input.assignee,
          dueDate: input.dueDate,
        });

        taskIds.push(task.id);
      }

      if (page.meta.exhausted) break;

      if (
        !page.meta.continuationCursor ||
        page.meta.continuationCursor === cursor
      )
        throw new Error('Incomplete invoice query');

      cursor = page.meta.continuationCursor;
    } while (true);

    return { reviewId: review.id, taskIds };
  },
);
