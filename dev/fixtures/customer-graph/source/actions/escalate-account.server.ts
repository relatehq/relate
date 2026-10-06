import type { ObjectId } from 'relate';
import { assertFields } from 'relate';
import { implementAction } from '../../validation/target.js';
import { graph } from '../graph.js';
import { EscalateAccount } from './escalate-account.js';

export const escalateAccount = implementAction(
  graph,
  EscalateAccount,
  async ({ actor, input, objects }) => {
    const customer = await objects.Customer.get(input.customer, {
      select: ['status'],
    });

    assertFields(customer, ['status']);

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

    const taskIds: ObjectId<'business.task'>[] = [];

    // Unknown filter evidence must reject, not silently drop matches. Relate
    // follows pages; a later failure must roll back the action's native writes.
    for await (const invoice of objects.Invoice.query({
      where: { customer: customer.id, status: 'open' },
      select: ['id'],
      limit: 100,
    })) {
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

    return { reviewId: review.id, taskIds };
  },
);
