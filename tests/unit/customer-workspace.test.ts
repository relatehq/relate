import { describe, expect, it } from 'vitest';
import { startWorkspace } from '../../examples/03-customer-workspace/src/app.js';
import { startServer } from '../../examples/03-customer-workspace/src/server.js';

describe('interactive customer workspace', () => {
  it('reads SQLite invoices, enforces roles, replays reviews and refreshes the HTTP source', async () => {
    const app = await startWorkspace();

    try {
      const ana = await app.read('ana');
      const fin = await app.read('fin');

      expect(ana.customer).toMatchObject({
        status: 'ok',
        data: { name: 'Northwind' },
      });
      expect(ana.invoices.data).toHaveLength(2);
      expect(ana.invoices.data[0]?.meta.fields.totalMinor).toEqual({
        status: 'forbidden',
      });
      expect(
        ana.invoices.data.every(
          (invoice) => invoice.data.totalMinor === undefined,
        ),
      ).toBe(true);
      expect(
        fin.invoices.data.map((invoice) => invoice.data.totalMinor).sort(),
      ).toEqual([125000, 480000]);
      await expect(
        app.review('fin', 'Not permitted', 'denied'),
      ).rejects.toThrow();
      const receipt = await app.review('ana', 'Follow up Friday', 'review-1');

      expect(receipt.state).toBe('succeeded');
      expect(await app.review('ana', 'Follow up Friday', 'review-1')).toEqual(
        receipt,
      );
      const reviewed = await app.read('ana');

      expect(reviewed.reviews.data).toHaveLength(1);
      expect(reviewed.reviews.data[0]?.data.note).toBe('Follow up Friday');
      await app.rename('Northwind Studio');
      expect((await app.read('ana', true)).customer).toMatchObject({
        status: 'ok',
        data: { name: 'Northwind Studio' },
      });
    } finally {
      await app.close();
    }
  });
  it('serves the app and restricts demo operations to same-origin validated requests', async () => {
    const app = await startServer('http://127.0.0.1:4318/#token=example');

    try {
      expect(await (await fetch(app.url)).text()).toContain(
        'Customer workspace',
      );
      const request = (body: unknown, origin = app.url) =>
        fetch(`${app.url}/api`, {
          method: 'POST',
          headers: { Origin: origin, 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });

      expect(
        (
          await request(
            { operation: 'read', actor: 'ana' },
            'https://elsewhere.example',
          )
        ).status,
      ).toBe(403);
      expect(
        (await request({ operation: 'read', actor: 'admin' })).status,
      ).toBe(400);
      const result = await (
        await request({ operation: 'read', actor: 'ana' })
      ).json();

      expect(result.invoices.data).toHaveLength(2);
      expect(
        (
          await request({
            operation: 'review',
            actor: 'fin',
            note: 'No',
            idempotencyKey: 'denied',
          })
        ).status,
      ).toBe(400);
    } finally {
      await app.close();
    }
  });
});
