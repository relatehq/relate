/** Intended caller outcomes, typechecked only; action execution is unimplemented. */
import assert from 'node:assert/strict';
import type { ObjectId } from 'relate';
import { AddAccountReview } from '../source/actions/add-account-review.js';
import { EscalateAccount } from '../source/actions/escalate-account.js';
import type { graph } from '../source/graph.js';
import type { Customer } from '../source/model.js';
import { ana } from './setup.js';
import type { Consumer, Receipt, Relate } from './target.js';

type Request = Parameters<
  Consumer<typeof graph>['actions']['addAccountReview']
>[0];

/**
 * Future test-runner dependencies, NOT Relate APIs. Each scenario gets a fresh
 * graph and caller journal. The journal must persist across page reloads.
 */
export interface ReceiptScenarioDriver {
  readonly journal: {
    saveRequest(request: Request): Promise<void>;
    loadRequest(): Promise<Request>;
    saveInvocationId(id: string): Promise<void>;
    loadInvocationId(): Promise<string>;
  };
  /** Hold the next invocation after durable acceptance; finish waits for commit. */
  holdNextInvocation(): Promise<{ finish(): Promise<void> }>;
  /** Let the invocation commit, then reject delivery without exposing its receipt. */
  loseResponseAfterCommit(
    invoke: () => Promise<Receipt<typeof AddAccountReview>>,
  ): Promise<never>;
}

export async function pendingReceiptScenario(
  relate: Relate<typeof graph>,
  northwind: ObjectId<typeof Customer.id>,
  driver: ReceiptScenarioDriver,
) {
  const request = {
    input: { customer: northwind, note: 'Follow up on the open invoice' },
    idempotencyKey: 'review-pending',
  };
  const held = await driver.holdNextInvocation();

  await driver.journal.saveRequest(request);

  const pending = await relate.as(ana).actions.addAccountReview(request);

  assert.equal(pending.state, 'pending');
  assert.ok(pending.invocationId);
  await driver.journal.saveInvocationId(pending.invocationId);

  // Re-open the page: reload its saved ID and use a freshly authenticated caller.
  const invocationId = await driver.journal.loadInvocationId();

  assert.deepEqual(
    await relate.as(ana).receipts.get(AddAccountReview, invocationId),
    pending,
  );
  assert.deepEqual(
    await relate.as(ana).actions.addAccountReview(request),
    pending,
  );
  await held.finish();

  const completed = await relate
    .as(ana)
    .receipts.get(AddAccountReview, invocationId);

  assert.equal(completed.invocationId, invocationId);
  assert.equal(completed.state, 'succeeded');
  assert.equal(
    (await relate.as(ana).objects.AccountReview.get(completed.output.reviewId))
      .status,
    'ok',
  );

  // The runtime must also verify the supplied action matches the stored invocation.
  await assert.rejects(
    relate.as(ana).receipts.get(EscalateAccount, invocationId),
  );

  // These principals come from the host's current authentication, not request input.
  const revokedPrincipals = [
    { ...ana, roles: ['employee'] as const },
    { ...ana, claims: { portfolio: 'portfolio_south' } },
  ];

  for (const principal of revokedPrincipals) {
    const currentCaller = relate.as(principal);

    await assert.rejects(
      currentCaller.receipts.get(AddAccountReview, invocationId),
    );
    await assert.rejects(currentCaller.actions.addAccountReview(request));
  }

  // A later host-authenticated restoration of access reveals the unchanged success.
  assert.deepEqual(
    await relate.as(ana).receipts.get(AddAccountReview, invocationId),
    completed,
  );
}

export async function lostResponseScenario(
  relate: Relate<typeof graph>,
  northwind: ObjectId<typeof Customer.id>,
  driver: ReceiptScenarioDriver,
) {
  const request = {
    input: { customer: northwind, note: 'Follow up after a lost response' },
    idempotencyKey: 'review-lost-response',
  };

  await driver.journal.saveRequest(request);
  await assert.rejects(
    driver.loseResponseAfterCommit(() =>
      relate.as(ana).actions.addAccountReview(request),
    ),
  );

  // Test observer sees the committed object; the caller received no invocation ID.
  const before = await relate
    .as(ana)
    .objects.Customer.traverse.reviews(northwind);

  assert.equal(before.data.length, 1);

  const savedRequest = await driver.journal.loadRequest();
  const recovered = await relate.as(ana).actions.addAccountReview(savedRequest);

  assert.equal(recovered.state, 'succeeded');
  assert.equal(recovered.output.reviewId, before.data[0]!.id);
  assert.deepEqual(
    await relate.as(ana).receipts.get(AddAccountReview, recovered.invocationId),
    recovered,
  );
  const after = await relate
    .as(ana)
    .objects.Customer.traverse.reviews(northwind);

  // Read evidence may change; the committed business records must not.
  assert.deepEqual(
    after.data.map((review) => review.data),
    before.data.map((review) => review.data),
  );
  await assert.rejects(
    relate.as(ana).actions.addAccountReview({
      ...savedRequest,
      input: {
        ...savedRequest.input,
        note: 'Different input under the same key',
      },
    }),
  );
}
