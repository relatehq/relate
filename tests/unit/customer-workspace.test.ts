import { describe, expect, it, vi } from 'vitest';
import { Server } from 'node:http';
import { ActionError } from '@relate/protocol';
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
      ).toBe(403);
    } finally {
      await app.close();
    }
  });
});

it('uses typed error statuses and logs unexpected failures without returning details', async () => {
  const read = vi
    .fn()
    .mockRejectedValue(new TypeError('private connector detail'));
  const workspace = {
    read,
    review: vi.fn().mockRejectedValue(new ActionError('unavailable')),
    rename: vi.fn(),
    close: vi.fn(),
  };
  const reportError = vi.fn();
  const app = await startServer('http://127.0.0.1:4318/#token=test', {
    workspaceFactory: async () => workspace,
    reportError,
  });

  try {
    const request = (body: unknown) =>
      fetch(`${app.url}/api`, {
        method: 'POST',
        headers: { Origin: app.url, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
    const failed = await request({ operation: 'read', actor: 'ana' });

    expect(failed.status).toBe(500);
    expect(await failed.text()).not.toContain('private connector detail');
    expect(reportError).toHaveBeenCalledWith(expect.any(TypeError));
    const unavailable = await request({
      operation: 'review',
      actor: 'ana',
      note: 'Review',
      idempotencyKey: 'key',
    });

    expect(unavailable.status).toBe(503);
    read.mockRejectedValue(new SyntaxError('application bug'));
    expect((await request({ operation: 'read', actor: 'ana' })).status).toBe(
      500,
    );
  } finally {
    await app.close();
  }
});

it('cleans the workspace after a server-close error and shares repeated close calls', async () => {
  const closeWorkspace = vi.fn(async () => {});
  const workspace = {
    read: vi.fn(),
    review: vi.fn(),
    rename: vi.fn(),
    close: closeWorkspace,
  };
  const app = await startServer('http://127.0.0.1:4318/#token=test', {
    workspaceFactory: async () => workspace,
  });
  const closeServer = Server.prototype.close;
  const failure = new Error('Server close failed');
  const mockedClose = vi
    .spyOn(Server.prototype, 'close')
    .mockImplementationOnce(function (this: Server, callback) {
      // Actually close the listener, then inject its reported failure.
      return closeServer.call(this, () => callback?.(failure));
    });

  try {
    const first = app.close();

    expect(app.close()).toBe(first);
    await expect(first).rejects.toThrow('Server close failed');
    expect(closeWorkspace).toHaveBeenCalledOnce();
  } finally {
    mockedClose.mockRestore();
  }
});
