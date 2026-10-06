/** Server-only planning; records effects without executing business writes. */
import { implementAction } from './implement-action.server.js';
import { EscalateAccount } from './escalate-account.js';
import { AccountReview, Task } from '../model.js';

export const escalateAccount = implementAction(
  EscalateAccount,
  ({ actor, target, input, reads, changes }) => {
    const review = changes.create(AccountReview, {
      customer: target.id,
      author: actor.id,
      note: input.note,
    });
    const tasks = reads.invoices
      .filter((invoice) => invoice.data.status === 'open')
      .map((invoice) =>
        changes.create(Task, {
          customer: target.id,
          review: review.id, // a real string: assigned at the call
          invoice: invoice.id,
          assignee: input.assignee,
          dueDate: input.dueDate,
        }),
      );

    return changes.build({
      reviewId: review.id,
      taskIds: tasks.map((task) => task.id),
    });
  },
);
