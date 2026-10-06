/** Server-only planning; records effects without executing business writes. */
import { implementAction } from './implement-action.server.js';
import { AddAccountReview } from './add-account-review.js';
import { AccountReview } from '../model.js';

export const addAccountReview = implementAction(
  AddAccountReview,
  ({ actor, target, input, changes }) => {
    const review = changes.create(AccountReview, {
      customer: target.id,
      author: actor.id, // the implementation decides this; the caller cannot
      note: input.note,
    });

    return changes.build({ reviewId: review.id });
  },
);
