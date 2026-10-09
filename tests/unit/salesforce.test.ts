import { expect, test } from 'vitest';
import { startApp } from '@relate/node';
import { assertFields } from 'relate';
import { customerApp } from '../support/salesforce/model.js';
import {
  accountId,
  fixture,
  orgId,
  queryResult,
  row,
} from '../support/salesforce/fixture.js';

test('reads application-owned Customers and refreshes upstream changes', async () => {
  const f = fixture();
  const model = customerApp(f.resource, orgId);
  const app = await startApp(model.app);

  try {
    const id = await app.host.adopt(model.Customer, accountId);
    const customer = app.as(model.employee).objects.Customer;
    const before = await customer.get(id, { select: ['name'] });

    assertFields(before, ['name']);
    expect(before.data.name).toBe('Northwind');
    f.respond(queryResult([{ ...row(), Name: 'Northwind Updated' }]));
    const after = await customer.get(id, { select: ['name'], refresh: true });

    assertFields(after, ['name']);
    expect(after.data.name).toBe('Northwind Updated');
    expect(
      await app
        .as({ id: 'outsider', roles: [], claims: {} })
        .objects.Customer.get(id),
    ).toEqual({ status: 'not-found' });
  } finally {
    await app.close();
  }
});

test.each(['denial', 'hidden', 'deleted', 'different-org'] as const)(
  'does not replay cached data after %s',
  async (mode) => {
    const f = fixture();
    const model = customerApp(f.resource, orgId);
    const app = await startApp(model.app);

    try {
      const id = await app.host.adopt(model.Customer, accountId);

      if (mode === 'denial') f.respond({}, 403);

      if (mode === 'hidden') f.respond(queryResult([]));

      if (mode === 'deleted')
        f.respond(queryResult([{ ...row(), IsDeleted: true }]));

      if (mode === 'different-org') f.setOrg('00D000000000002EAA');

      expect(
        await app
          .as(model.employee)
          .objects.Customer.get(id, { select: ['name'], refresh: true }),
      ).toEqual({ status: 'not-found' });
    } finally {
      await app.close();
    }
  },
);

test('temporary failures may retain authorized stale values', async () => {
  const f = fixture();
  const model = customerApp(f.resource, orgId);
  const app = await startApp(model.app);

  try {
    const id = await app.host.adopt(model.Customer, accountId);

    f.respond({}, 503);
    const result = await app
      .as(model.employee)
      .objects.Customer.get(id, { select: ['name'], refresh: true });

    assertFields(result, ['name']);
    expect(result.data.name).toBe('Northwind');
    expect(result.meta.fields?.name).toMatchObject({ refresh: 'unavailable' });
  } finally {
    await app.close();
  }
});
