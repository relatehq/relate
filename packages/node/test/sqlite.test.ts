import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { expect, test } from 'vitest';
import { startApp } from '@relate/node';
import { bind, defineApp } from 'relate';
import { sqlite } from '@relate/connector-sqlite';
import { createCustomerGraph } from '../../../tests/support/customer-graph.js';

test('executes typed authorized reads without an account table', async ({
  onTestFinished,
}) => {
  // Arrange: this test owns its graph, data and application lifecycle.
  const { Customer, customers, customerGraph, employee } =
    createCustomerGraph();
  const directory = mkdtempSync(join(tmpdir(), 'relate-sqlite-app-'));

  onTestFinished(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, 'crm.sqlite');

  const db = new DatabaseSync(path);

  onTestFinished(() => db.close());
  db.exec(`CREATE TABLE customers (id TEXT PRIMARY KEY, display_name TEXT, portfolio TEXT, revenue REAL);
    INSERT INTO customers VALUES ('crm_mothlight', 'Mothlight', 'portfolio_north', 10), ('crm_south', 'Saltglass Works', 'portfolio_south', 20);`);
  const app = await startApp(
    defineApp({
      graph: customerGraph,
      setup({ onDispose }) {
        const database = sqlite({ connectionId: 'test-crm', path });

        onDispose(() => database.close());

        return {
          bindings: [bind(customers, database.table('customers'))],
        };
      },
    }),
  );

  try {
    const id = await app.host.adopt(Customer, 'crm_mothlight');
    const south = await app.host.adopt(Customer, 'crm_south');
    const objects = app.as(employee).objects;

    expect(await objects.Customer.get(id)).toMatchObject({
      status: 'ok',
      data: { name: 'Mothlight' },
    });
    expect(await objects.Customer.get(south)).toMatchObject({
      status: 'not-found',
    });
    db.exec(
      "UPDATE customers SET display_name = 'Mothlight Ltd' WHERE id = 'crm_mothlight'",
    );
    expect(await objects.Customer.get(id, { maxAgeMs: 0 })).toMatchObject({
      status: 'ok',
      data: { name: 'Mothlight Ltd' },
    });
    db.exec("DELETE FROM customers WHERE id = 'crm_mothlight'");
    expect(await objects.Customer.get(id, { maxAgeMs: 0 })).toMatchObject({
      status: 'not-found',
    });
  } finally {
    await app.close();
  }
});
