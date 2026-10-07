/** Intended runtime outcomes: typechecked, never executed against a fake executor. */
import assert from 'node:assert/strict';
import { referenceInput } from 'relate';
import type { ObjectId } from 'relate';
import { AddAccountReview } from '../source/actions/add-account-review.js';
import type { addAccountReview } from '../source/actions/add-account-review.server.js';
import { graph } from '../source/graph.js';
import { AccountReview, Customer, Invoice } from '../source/model.js';
import { ana } from './setup.js';
import { implementAction } from './target.js';
import type { Relate } from './target.js';

/** Future test-runner hooks, not public Relate APIs or a substitute executor. */
export interface ReferenceWriteScenarioDriver {
  /**
   * Open a fresh installed graph using the supplied addAccountReview implementation
   * and the fixture's other implementations, connectors and records. Run against
   * both memory and Postgres once native actions exist.
   */
  open(implementation: typeof addAccountReview): Promise<{
    readonly relate: Relate<typeof graph>;
    /**
     * Inspect every committed review in this graph directly through storage,
     * independently of caller read policies. No pending transaction is visible.
     */
    committedReviews(): Promise<
      readonly {
        readonly id: ObjectId<typeof AccountReview.id>;
        readonly customer: ObjectId<typeof Customer.id>;
        readonly author: string;
        readonly note: string;
      }[]
    >;
  }>;
}

export async function referenceWriteScenario(
  driver: ReferenceWriteScenarioDriver,
) {
  const cases = [
    { name: 'permitted', target: 'northwind', atWrite: false, prefix: false },
    {
      name: 'wrong-type-input',
      target: 'invoice',
      atWrite: false,
      prefix: false,
    },
    {
      name: 'wrong-type-write',
      target: 'invoice',
      atWrite: true,
      prefix: false,
    },
    { name: 'missing-write', target: 'missing', atWrite: true, prefix: false },
    { name: 'denied-write', target: 'southbank', atWrite: true, prefix: false },
    {
      name: 'wrong-type-rollback',
      target: 'invoice',
      atWrite: true,
      prefix: true,
    },
    {
      name: 'denied-rollback',
      target: 'southbank',
      atWrite: true,
      prefix: true,
    },
  ] as const;

  for (const test of cases) {
    let reachedWrite = false;
    let createdPrefix = false;
    const implementation = implementAction(
      graph,
      AddAccountReview,
      async ({ actor, input, objects }) => {
        // Deliberately no Customer.get(): write enforcement owns these checks.
        if (test.prefix) {
          await objects.AccountReview.create({
            customer: input.customer,
            author: actor.id,
            note: 'Valid earlier write that must roll back',
          });
          createdPrefix = true;
        }

        reachedWrite = true;

        const review = await objects.AccountReview.create({
          // The write cases use a scalar input to ensure that validating only
          // referenceInput fields at invocation cannot satisfy this scenario.
          customer: test.atWrite
            ? referenceInput(Customer).parse(input.note)
            : input.customer,
          author: actor.id,
          note: 'Follow up',
        });

        return { reviewId: review.id };
      },
    );
    const { relate, committedReviews } = await driver.open(implementation);

    try {
      const northwind = await relate.host.adopt(Customer, 'crm_456');
      const southbank = await relate.host.adopt(Customer, 'crm_789');
      const invoice = await relate.host.adopt(Invoice, 'inv_1');
      const rawId = { northwind, southbank, invoice, missing: 'not-adopted' }[
        test.target
      ];

      assert.deepEqual(await committedReviews(), []);

      // Model the external boundary without casts: parsing declares the expected
      // object type but does not prove membership or grant write permission.
      const input = AddAccountReview.input.parse({
        customer: test.atWrite ? northwind : rawId,
        note: test.atWrite ? rawId : 'Follow up',
      });
      const receipt = await relate.as(ana).actions.addAccountReview({
        input,
        idempotencyKey: test.name,
      });

      if (test.atWrite) assert.equal(reachedWrite, true, test.name);

      if (test.prefix) assert.equal(createdPrefix, true, test.name);

      if (test.name === 'permitted') {
        assert.equal(receipt.state, 'succeeded');
        assert.deepEqual(await committedReviews(), [
          {
            id: receipt.output.reviewId,
            customer: northwind,
            author: ana.id,
            note: 'Follow up',
          },
        ]);
      } else {
        assert.equal(receipt.state, 'failed', test.name);
        assert.equal(receipt.error.kind, 'runtime');
        // Exact public mapping remains open; an implementation fault is not a
        // passing policy/identity rejection, and private evidence must not leak.
        assert.ok(
          ['invalid', 'not-found', 'denied'].includes(receipt.error.code),
        );
        assert.deepEqual(receipt.error, {
          kind: 'runtime',
          code: receipt.error.code,
        });
        assert.deepEqual(await committedReviews(), [], test.name);
      }
    } finally {
      await relate.close();
    }
  }
}
