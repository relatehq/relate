import assert from 'node:assert/strict';
import { ana, createFixtureApp, fin } from './setup.js';
import { Customer, Invoice } from '../source/model.js';

/** The acceptance path: an authorized read, a traversal, and a native action. */
export async function scenario() {
  const relate = createFixtureApp();

  try {
    const mothlight = await relate.host.adopt(Customer, 'crm_456');
    const kettlewick = await relate.host.adopt(Customer, 'crm_789');

    const openInvoice = await relate.host.adopt(Invoice, 'inv_1');

    await relate.host.adopt(Invoice, 'inv_2');

    assert.notEqual(mothlight, 'crm_456');

    // Ana may read the customer, but not its financial field group.
    const customer = await relate.as(ana).objects.Customer.get(mothlight, {
      select: ['name', 'revenue'],
    });

    assert.equal(customer.status, 'ok');
    assert.equal(customer.id, mothlight);
    assert.deepEqual(customer.data, { name: 'Mothlight Studio' });
    assert.equal(customer.meta.completeness, 'partial');
    assert.equal(customer.meta.fields.name?.status, 'available');
    assert.equal(customer.meta.fields.revenue?.status, 'forbidden');

    // Finance in the same portfolio also sees revenue.
    const financial = await relate.as(fin).objects.Customer.get(mothlight, {
      select: ['name', 'revenue'],
    });

    assert.equal(financial.status, 'ok');
    assert.deepEqual(financial.data, {
      name: 'Mothlight Studio',
      revenue: 2_000_000,
    });
    assert.equal(financial.meta.completeness, 'complete');

    // Another portfolio's customer is indistinguishable from a missing one.
    assert.deepEqual(await relate.as(ana).objects.Customer.get(kettlewick), {
      status: 'not-found',
    });

    const customers = await relate.as(ana).objects.Customer.query({
      select: ['id', 'name'],
    });

    assert.deepEqual(
      customers.data.map((row) => row.data),
      [{ id: mothlight, name: 'Mothlight Studio' }],
    );
    assert.equal(customers.meta.exhausted, true);

    // Billing's CRM key was translated: invoices hang off the Relate customer.
    const invoices = await relate
      .as(fin)
      .objects.Customer.traverse.invoices(mothlight, {
        select: ['customer', 'status', 'totalMinor'],
      });
    const open = invoices.data.filter((row) => row.data.status === 'open');

    assert.equal(invoices.data.length, 2);
    assert.deepEqual(
      open.map((row) => row.data),
      [{ customer: mothlight, status: 'open', totalMinor: 250_000 }],
    );

    // Consumers can express the same filtered query used inside escalation.
    const openInvoices = await relate.as(ana).objects.Invoice.query({
      where: { customer: mothlight, status: 'open' },
      select: ['id'],
      limit: 100,
    });

    assert.deepEqual(
      openInvoices.data.map((row) => row.id),
      [openInvoice],
    );
    assert.equal(openInvoices.meta.exhausted, true);

    // Ana records a review. The implementation sets the author; she cannot choose it.
    const request = {
      input: { customer: mothlight, note: 'Follow up on the open invoice' },
      idempotencyKey: 'review-2026-10',
    };
    const receipt = await relate.as(ana).actions.addAccountReview(request);

    assert.equal(receipt.state, 'succeeded');

    const reviews = await relate
      .as(ana)
      .objects.Customer.traverse.reviews(mothlight);

    assert.deepEqual(
      reviews.data.map((row) => row.data),
      [
        {
          id: receipt.output.reviewId,
          customer: mothlight,
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
    assert.deepEqual(reviewed.data, { name: 'Mothlight Studio' });

    // A retry returns the original outcome and creates nothing new.
    const retried = await relate.as(ana).actions.addAccountReview(request);

    assert.deepEqual(retried, receipt);
    assert.equal(
      (await relate.as(ana).objects.Customer.traverse.reviews(mothlight)).data
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

    // Several native objects in one commit; source queries run as Ana.
    const escalation = await relate.as(ana).actions.escalateAccount({
      input: {
        customer: mothlight,
        note: 'Escalated',
        assignee: 'sam',
        dueDate: '2026-10-20',
      },
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
          customer: mothlight,
          review: escalation.output.reviewId,
          invoice: openInvoice,
          assignee: 'sam',
          dueDate: '2026-10-20',
        },
      ],
    );
    // Dependent read: the invoice supplies the customer ID for the next lookup.
    const invoiceReview = await relate.as(ana).actions.reviewInvoice({
      input: { invoice: openInvoice, note: 'Check payment timing' },
      idempotencyKey: 'invoice-review-2026-10',
    });

    assert.equal(invoiceReview.state, 'succeeded');
    const invoiceReviewRecord = await relate
      .as(ana)
      .objects.AccountReview.get(invoiceReview.output.reviewId, {
        select: ['customer', 'author', 'note'],
      });

    assert.equal(invoiceReviewRecord.status, 'ok');
    assert.deepEqual(invoiceReviewRecord.data, {
      customer: mothlight,
      author: 'ana',
      note: 'Mothlight Studio: Check payment timing',
    });
  } finally {
    await relate.close();
  }
}
