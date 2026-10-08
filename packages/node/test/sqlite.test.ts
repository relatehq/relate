import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { expect, test } from 'vitest';
import { startApp } from '@relate/node';
import { customerAccounts } from '../../../examples/02-customer-accounts/src/app.js';
import {
  Customer,
  employee,
} from '../../../examples/02-customer-accounts/src/model.js';
import { seed } from '../../../examples/02-customer-accounts/src/seed.js';

test('executes typed authorized reads without an account table', async ({
  onTestFinished,
}) => {
  const directory = mkdtempSync(join(tmpdir(), 'relate-sqlite-app-'));

  onTestFinished(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, 'crm.sqlite');

  seed(path);
  const db = new DatabaseSync(path);

  onTestFinished(() => db.close());
  const app = await startApp(customerAccounts(path));

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
