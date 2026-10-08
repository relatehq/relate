import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startApp } from '@relate/node';
import { assertFields } from 'relate';
import { customerAccounts } from './app.js';
import { Customer, employee } from './model.js';
import { seed } from './seed.js';

const directory = await mkdtemp(join(tmpdir(), 'relate-customer-accounts-'));

try {
  const path = join(directory, 'crm.sqlite');

  seed(path);
  const app = await startApp(customerAccounts(path));

  try {
    const northwind = await app.host.adopt(Customer, 'crm_northwind');
    const south = await app.host.adopt(Customer, 'crm_south');
    const { objects } = app.as(employee);
    const customer = await objects.Customer.get(northwind, {
      select: ['name', 'stripeCustomerId'],
    });

    assertFields(customer, ['name', 'stripeCustomerId']);
    assert.equal(customer.data.name, 'Northwind');
    assert.equal(customer.data.stripeCustomerId, 'cus_demo_northwind');
    assert.equal((await objects.Customer.get(south)).status, 'not-found');
    console.log(JSON.stringify(customer, null, 2));
    console.log(
      'The employee can read Northwind; the other portfolio is hidden.',
    );
  } finally {
    await app.close();
  }
} finally {
  await rm(directory, { recursive: true, force: true });
}
