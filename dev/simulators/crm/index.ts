// Independent HTTP provider fixture. No Relate imports or runtime schemas.
import { once } from 'node:events';
import { createServer } from 'node:http';
import { getRequestListener } from '@hono/node-server';
import { Hono } from 'hono';

export async function startCrmSimulator() {
  let record: Record<string, unknown> = {
    id: 'crm_456',
    display_name: 'Northwind',
    portfolio: 'portfolio_north',
    revenue: 2_000_000,
    private_unmapped: 'never return this',
  };
  let version = 1;
  let deleted = false;
  let recordsUnavailable = false;
  let providerAccountId = 'example-account';
  const app = new Hono();

  app.get('/account', (context) => context.json({ id: providerAccountId }));
  app.get('/customers/crm_456', (context) =>
    recordsUnavailable
      ? context.json({}, 503)
      : context.json({
          providerAccountId,
          state: deleted ? 'deleted' : 'present',
          ...(deleted ? {} : { record }),
          version: { domain: 'crm-v1', value: String(version) },
        }),
  );
  app.notFound((context) => context.json({}, 404));

  const server = createServer(getRequestListener(app.fetch));
  const listening = once(server, 'listening');

  server.listen(0, '127.0.0.1');
  await listening;
  const address = server.address();

  if (!address || typeof address === 'string')
    throw new Error('CRM listener did not provide a TCP address');

  let stopping: Promise<void> | undefined;

  return {
    url: `http://127.0.0.1:${address.port}`,
    // Identity remains verifiable while the records service is unavailable.
    setRecordsUnavailable(value: boolean) {
      recordsUnavailable = value;
    },
    setAccount(id: string) {
      providerAccountId = id;
    },
    async update(patch: Record<string, unknown>, isDeleted = false) {
      if (stopping) throw new Error('CRM simulator is stopped');

      record = { ...record, ...structuredClone(patch) };
      deleted = isDeleted;
      version++;
    },
    stop() {
      stopping ??= new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeAllConnections();
      });

      return stopping;
    },
  };
}
