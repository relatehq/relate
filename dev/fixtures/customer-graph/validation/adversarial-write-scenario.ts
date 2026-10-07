/** Intended acceptance assertions, typechecked only until native execution exists. */
import assert from 'node:assert/strict';
import type { ObjectId } from 'relate';
import { AddAccountReview } from '../source/actions/add-account-review.js';
import { AccountReview, Customer, Invoice, Task } from '../source/model.js';
import {
  AdversarialWrite,
  adversarialGraph,
  adversarialWrite,
} from './adversarial-writes.js';
import { ana } from './setup.js';
import type { Receipt, Relate } from './target.js';

/** Trusted test instrumentation, not new public APIs or a fake policy evaluator. */
export interface AdversarialWriteScenarioDriver {
  /**
   * Fresh storage per case, fixture connectors/records and all graph actions.
   * Install the supplied unsafe implementation plus the ordinary implementations.
   * Future runners should exercise both memory and Postgres native transactions.
   */
  open(
    graph: typeof adversarialGraph,
    implementation: typeof adversarialWrite,
  ): Promise<{
    readonly relate: Relate<typeof adversarialGraph>;
    /** Await the accepted invocation's final outcome through trusted instrumentation. */
    completedReceipt<
      A extends typeof AdversarialWrite | typeof AddAccountReview,
    >(
      action: A,
      receipt: Receipt<A>,
    ): Promise<Receipt<A>>;
    /**
     * Read ALL committed native rows directly from storage, sorted by ID.
     * Do not use Ana's filtered reads: they could conceal unauthorized writes.
     * No staged transaction writes may appear in this snapshot.
     */
    committedRows(): Promise<{
      readonly reviews: readonly {
        readonly id: ObjectId<typeof AccountReview.id>;
        readonly customer: ObjectId<typeof Customer.id>;
        readonly author: string;
        readonly note: string;
      }[];
      readonly tasks: readonly {
        readonly id: ObjectId<typeof Task.id>;
        readonly customer: ObjectId<typeof Customer.id>;
        readonly invoice: ObjectId<typeof Invoice.id>;
        readonly review: ObjectId<typeof AccountReview.id>;
        readonly assignee: string;
        readonly dueDate: string;
      }[];
    }>;
  }>;
}

export async function adversarialWriteScenario(
  driver: AdversarialWriteScenarioDriver,
) {
  const cases = [
    'permitted-without-lookup',
    'outside-portfolio-without-lookup',
    'another-author',
    'cross-portfolio-invoice',
    'readable-other-customer-invoice',
    'readable-other-customer-review',
  ] as const;

  for (const name of cases) {
    const { relate, completedReceipt, committedRows } = await driver.open(
      adversarialGraph,
      adversarialWrite,
    );

    try {
      const northwind = await relate.host.adopt(Customer, 'crm_456');
      const harbour = await relate.host.adopt(Customer, 'crm_654');
      const southbank = await relate.host.adopt(Customer, 'crm_789');
      const northInvoice = await relate.host.adopt(Invoice, 'inv_1');
      const harbourInvoice = await relate.host.adopt(
        Invoice,
        'inv_north_other',
      );
      const southInvoice = await relate.host.adopt(Invoice, 'inv_south');
      const caller = relate.as(ana);

      assert.deepEqual(await committedRows(), { reviews: [], tasks: [] });

      // Seed through an ordinary authorized action; no privileged native insert.
      const seed = await completedReceipt(
        AddAccountReview,
        await caller.actions.addAccountReview({
          input: { customer: harbour, note: 'Existing Harbour review' },
          idempotencyKey: 'seed-harbour-review',
        }),
      );

      assert.equal(seed.state, 'succeeded');

      // Prove that same-portfolio mismatches cannot pass by read permission alone.
      for (const id of [northwind, harbour]) {
        assert.equal((await caller.objects.Customer.get(id)).status, 'ok');
      }

      for (const id of [northInvoice, harbourInvoice]) {
        assert.equal((await caller.objects.Invoice.get(id)).status, 'ok');
      }

      assert.equal(
        (await caller.objects.AccountReview.get(seed.output.reviewId)).status,
        'ok',
      );

      const before = await committedRows();

      assert.deepEqual(before.tasks, []);
      assert.deepEqual(before.reviews, [
        {
          id: seed.output.reviewId,
          customer: harbour,
          author: ana.id,
          note: 'Existing Harbour review',
        },
      ]);

      const receipt = await completedReceipt(
        AdversarialWrite,
        await caller.actions.adversarialWrite({
          input: {
            customer:
              name === 'outside-portfolio-without-lookup'
                ? southbank
                : northwind,
            author: name === 'another-author' ? 'sara' : ana.id,
            invoice:
              name === 'readable-other-customer-invoice'
                ? harbourInvoice
                : name === 'cross-portfolio-invoice' ||
                    name === 'outside-portfolio-without-lookup'
                  ? southInvoice
                  : northInvoice,
            existingReview:
              name === 'readable-other-customer-review'
                ? seed.output.reviewId
                : undefined,
          },
          idempotencyKey: name,
        }),
      );
      const after = await committedRows();

      if (name === 'permitted-without-lookup') {
        assert.equal(receipt.state, 'succeeded', name);
        assert.deepEqual(
          after.reviews,
          [
            ...before.reviews,
            {
              id: receipt.output.reviewId,
              customer: northwind,
              author: ana.id,
              note: 'Adversarial write',
            },
          ].sort((a, b) => a.id.localeCompare(b.id)),
        );
        assert.deepEqual(after.tasks, [
          {
            id: receipt.output.taskId,
            customer: northwind,
            invoice: northInvoice,
            review: receipt.output.reviewId,
            assignee: 'sam',
            dueDate: '2026-10-20',
          },
        ]);
      } else {
        assert.equal(receipt.state, 'failed', name);
        assert.equal(receipt.error.kind, 'runtime', name);
        // Mapping is still open. Internal/unsupported/unavailable failures do
        // not count as policy enforcement; public errors expose no evidence.
        assert.ok(
          ['denied', 'not-found', 'invalid'].includes(receipt.error.code),
          name,
        );
        assert.deepEqual(receipt.error, {
          kind: 'runtime',
          code: receipt.error.code,
        });
        // Includes the valid review staged before a rejected Task.create().
        assert.deepEqual(after, before, name);
      }
    } finally {
      await relate.close();
    }
  }
}
