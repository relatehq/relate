/** Compile-time acceptance only. No executor or receipt store exists here. */
import type { ObjectId } from 'relate';
import { AddAccountReview } from '../source/actions/add-account-review.js';
import { EscalateAccount } from '../source/actions/escalate-account.js';
import { graph } from '../source/graph.js';
import type { AccountReview } from '../source/model.js';
import { defineAction } from './target.js';
import type { Consumer, Receipt } from './target.js';

type Expect<T extends true> = T;

type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
    ? true
    : false;

export async function receiptTypes(consumer: Consumer<typeof graph>) {
  const review = await consumer.receipts.get(AddAccountReview, 'inv_review');
  const inferred: Expect<
    Equal<typeof review, Receipt<typeof AddAccountReview>>
  > = true;
  const id: string = review.invocationId;

  void inferred;
  void id;

  if (review.state === 'succeeded') {
    const reviewId: ObjectId<typeof AccountReview.id> = review.output.reviewId;

    void reviewId;
    // @ts-expect-error lookup preserves this action's exact output
    review.output.taskIds;
  }

  if (review.state === 'pending' || review.state === 'uncertain') {
    // @ts-expect-error no confirmed output yet
    review.output;
    // @ts-expect-error no confirmed failure yet
    review.error;
  }

  const escalation = await consumer.receipts.get(
    EscalateAccount,
    'inv_escalation',
  );

  if (escalation.state === 'failed' && escalation.error.kind === 'domain') {
    if (escalation.error.code === 'tooManyInvoices') {
      const limit: number = escalation.error.details.limit;

      void limit;
      // @ts-expect-error receipt details retain their schema output type
      const invalid: string = escalation.error.details.limit;

      void invalid;
    }
  }

  const Unregistered = defineAction({
    ...AddAccountReview,
    id: 'unregistered',
  });

  // @ts-expect-error lookup only accepts actions registered in this graph
  consumer.receipts.get(Unregistered, 'inv_review');
  // @ts-expect-error an action contract, not its registry name
  consumer.receipts.get('addAccountReview', 'inv_review');
  // @ts-expect-error an invocation ID is required
  consumer.receipts.get(AddAccountReview);
}

// Every state carries the same required identity, including terminal failures.
// @ts-expect-error pending needs an invocation ID
const missingPendingId: Receipt<typeof AddAccountReview> = { state: 'pending' };
// @ts-expect-error uncertain needs an invocation ID
const missingUncertainId: Receipt<typeof AddAccountReview> = {
  state: 'uncertain',
};
// @ts-expect-error even a valid failure needs an invocation ID
const missingFailedId: Receipt<typeof AddAccountReview> = {
  state: 'failed',
  error: { kind: 'runtime', code: 'internal' },
};

export function successIdentity(
  output: Receipt<typeof AddAccountReview> & { state: 'succeeded' },
) {
  // @ts-expect-error successful output does not replace invocation identity
  const missingSucceededId: Receipt<typeof AddAccountReview> = {
    state: 'succeeded',
    output: output.output,
  };

  void missingSucceededId;
}

void missingPendingId;
void missingUncertainId;
void missingFailedId;
