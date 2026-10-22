import { describe, expect, it } from 'vitest';
import { startApp } from '@relate/node';
import workspaceApp, { seed } from '../relate.config.js';
import { actors } from '../src/app.js';

describe('customer workspace', () => {
  it('seeds the config runtime with repeatable customer and invoice membership', async () => {
    const relate = await startApp(workspaceApp);

    try {
      const { objects } = relate.as(actors.ana);

      expect((await objects.Customer.query()).data).toEqual([]);
      const first = await seed(relate);
      const second = await seed(relate);

      expect(second.customerId).toBe(first.customerId);
      expect((await objects.Customer.query()).data).toMatchObject([
        { id: first.customerId, data: { name: 'Mothlight' } },
      ]);
      const invoices = await objects.Customer.traverse.invoices(
        first.customerId,
      );

      expect(invoices.data).toHaveLength(2);
      expect(
        invoices.data
          .map((invoice) => invoice.data.totalMinor)
          .sort((a, b) => a! - b!),
      ).toEqual([125000, 480000]);
      expect((await objects.Invoice.query()).data).toHaveLength(2);
      const finInvoices = await relate.as(actors.fin).objects.Invoice.query();

      expect(
        finInvoices.data.every(
          (invoice) => invoice.data.totalMinor === undefined,
        ),
      ).toBe(true);
    } finally {
      await relate.close();
    }
  });
  it('enforces review permissions and replays the committed receipt', async () => {
    const relate = await startApp(workspaceApp);

    try {
      const { customerId } = await seed(relate);
      const ana = relate.as(actors.ana);
      const fin = relate.as(actors.fin);
      const request = {
        input: { customer: customerId, note: 'Follow up Friday' },
        idempotencyKey: 'review-1',
      };

      expect(
        await ana.objects.Customer.get(customerId, { select: ['revenue'] }),
      ).toMatchObject({
        meta: { fields: { revenue: { status: 'forbidden' } } },
      });
      expect(await fin.objects.Customer.get(customerId)).toMatchObject({
        data: { revenue: 2000000 },
      });
      await expect(fin.actions.addAccountReview(request)).rejects.toThrow();
      const receipt = await ana.actions.addAccountReview(request);

      expect(receipt.state).toBe('succeeded');
      expect(await ana.actions.addAccountReview(request)).toEqual(receipt);
      expect(
        await ana.objects.AccountReview.get(receipt.output.reviewId),
      ).toMatchObject({
        data: { note: 'Follow up Friday', author: 'ana' },
      });
    } finally {
      await relate.close();
    }
  });
});
