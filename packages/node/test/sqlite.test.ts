import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { expect, test } from 'vitest';
import { startApp } from '@relate/node';
import { connect, defineApp } from 'relate';
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
    INSERT INTO customers VALUES ('crm_northwind', 'Northwind', 'portfolio_north', 10), ('crm_south', 'South Coast', 'portfolio_south', 20);`);
  const app = await startApp(
    defineApp({
      graph: customerGraph,
      setup({ onDispose }) {
        const database = sqlite({ path });

        onDispose(() => database.close());

        return {
          connections: [
            connect(customers, {
              connectionId: 'test-crm',
              connector: database.table('customers', {
                idColumn: 'id',
                columns: ['display_name', 'portfolio', 'revenue'],
              }),
            }),
          ],
        };
      },
    }),
  );

  try {
    const id = await app.host.adopt(Customer, 'crm_northwind');
    const south = await app.host.adopt(Customer, 'crm_south');
    const objects = app.as(employee).objects;

    expect(await objects.Customer.get(id)).toMatchObject({
      status: 'ok',
      data: { name: 'Northwind' },
    });
    expect(await objects.Customer.get(south)).toMatchObject({
      status: 'not-found',
    });
    db.exec(
      "UPDATE customers SET display_name = 'Northwind Ltd' WHERE id = 'crm_northwind'",
    );
    expect(await objects.Customer.get(id, { maxAgeMs: 0 })).toMatchObject({
      status: 'ok',
      data: { name: 'Northwind Ltd' },
    });
    db.exec("DELETE FROM customers WHERE id = 'crm_northwind'");
    expect(await objects.Customer.get(id, { maxAgeMs: 0 })).toMatchObject({
      status: 'not-found',
    });
  } finally {
    await app.close();
  }
});
