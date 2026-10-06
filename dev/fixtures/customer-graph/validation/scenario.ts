import assert from 'node:assert/strict';
import { ana, createFixtureApp, fin } from './setup.js';
import { Customer, Invoice } from '../source/model.js';

/** The acceptance path: an authorized read, a traversal, and a native action. */
export async function scenario() {
  const relate = createFixtureApp();

  try {
    const northwind = await relate.host.adopt(Customer, 'crm_456');
    const southbank = await relate.host.adopt(Customer, 'crm_789');

    const openInvoice = await relate.host.adopt(Invoice, 'inv_1');

    await relate.host.adopt(Invoice, 'inv_2');

    assert.notEqual(northwind, 'crm_456');

    // Ana may read the customer, but not its financial field group.
    const customer = await relate.as(ana).objects.Customer.get(northwind, {
      select: ['name', 'revenue'],
    });

    assert.equal(customer.status, 'ok');
    assert.equal(customer.id, northwind);
    assert.deepEqual(customer.data, { name: 'Northwind Studio' });
    assert.equal(customer.meta.completeness, 'partial');
    assert.equal(customer.meta.fields.name?.status, 'available');
    assert.equal(customer.meta.fields.revenue?.status, 'unavailable');

    // Finance in the same organization also sees revenue.
    const financial = await relate.as(fin).objects.Customer.get(northwind, {
      select: ['name', 'revenue'],
    });

    assert.equal(financial.status, 'ok');
    assert.deepEqual(financial.data, {
      name: 'Northwind Studio',
      revenue: 2_000_000,
    });
    assert.equal(financial.meta.completeness, 'complete');

    // Another organization's customer is indistinguishable from a missing one.
    assert.deepEqual(await relate.as(ana).objects.Customer.get(southbank), {
      status: 'not-found',
    });

    const listed = await relate.as(ana).objects.Customer.list({
      select: ['id', 'name'],
    });

    assert.deepEqual(
      listed.data.map((row) => row.data),
      [{ id: northwind, name: 'Northwind Studio' }],
    );
    assert.equal(listed.meta.exhausted, true);

    // Billing's CRM key was translated: invoices hang off the Relate customer.
    const invoices = await relate
      .as(fin)
      .objects.Customer.traverse.invoices(northwind, {
        select: ['customer', 'status', 'totalMinor'],
      });
    const open = invoices.data.filter((row) => row.data.status === 'open');

    assert.equal(invoices.data.length, 2);
    assert.deepEqual(
      open.map((row) => row.data),
      [{ customer: northwind, status: 'open', totalMinor: 250_000 }],
    );

    // Ana records a review. The implementation sets the author; she cannot choose it.
    const request = {
      target: northwind,
      input: { note: 'Follow up on the open invoice' },
      idempotencyKey: 'review-2026-10',
    };
    const receipt = await relate.as(ana).actions.addAccountReview(request);

    assert.equal(receipt.state, 'succeeded');

    const reviews = await relate
      .as(ana)
      .objects.Customer.traverse.reviews(northwind);

    assert.deepEqual(
      reviews.data.map((row) => row.data),
      [
        {
          id: receipt.output.reviewId,
          customer: northwind,
          author: 'ana',
          note: 'Follow up on the open invoice',
        },
      ],
    );

    // The same relationship reads in reverse.
    const reviewed = await relate
      .as(ana)
      .objects.AccountReview.traverse.customer(receipt.output.reviewId, {
        select: ['name'],
      });

    assert.equal(reviewed.status, 'ok');
    assert.deepEqual(reviewed.data, { name: 'Northwind Studio' });

    // A retry returns the original outcome and creates nothing new.
    const retried = await relate.as(ana).actions.addAccountReview(request);

    assert.deepEqual(retried, receipt);
    assert.equal(
      (await relate.as(ana).objects.Customer.traverse.reviews(northwind)).data
        .length,
      1,
    );

    // No action policy allows Fin's roles.
    await assert.rejects(
      relate.as(fin).actions.addAccountReview({
        ...request,
        idempotencyKey: 'review-by-finance',
      }),
    );

    // Several objects in one commit. The implementation read the invoices as Ana.
    const escalation = await relate.as(ana).actions.escalateAccount({
      target: northwind,
      input: { note: 'Escalated', assignee: 'sam', dueDate: '2026-10-20' },
      idempotencyKey: 'escalate-2026-10',
    });

    assert.equal(escalation.state, 'succeeded');
    assert.equal(escalation.output.taskIds.length, 1);

    const tasks = await relate
      .as(ana)
      .objects.AccountReview.traverse.tasks(escalation.output.reviewId);

    assert.deepEqual(
      tasks.data.map((row) => row.data),
      [
        {
          id: escalation.output.taskIds[0],
          customer: northwind,
          review: escalation.output.reviewId,
          invoice: openInvoice,
          assignee: 'sam',
          dueDate: '2026-10-20',
        },
      ],
    );
  } finally {
    await relate.close();
  }
}
