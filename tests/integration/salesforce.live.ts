import assert from 'node:assert/strict';
import { startApp } from '@relate/node';
import { salesforce } from '@relate/connector-salesforce';
import { SourceAccessDenied } from 'relate/connectors';
import { assertFields } from 'relate';
import { withScratchOrg } from '@relate/dev-salesforce/harness';
import { customerApp } from '../support/salesforce/model.js';

try {
  await withScratchOrg(async (org, signal) => {
    const { orgId, accountIds } = await org.info();
    const credentials = await org.credentials();
    const connector = salesforce({
      credentials,
      apiVersion: '67.0',
      timeoutMs: 30_000,
    }).resource('Account', { fields: ['Name', 'Website'] });
    const providerAccountId = await connector.identify({ signal });

    assert.equal(providerAccountId.slice(0, 15), orgId.slice(0, 15));
    const model = customerApp(connector, providerAccountId);
    const app = await startApp(model.app);

    try {
      signal.throwIfAborted();
      const sourceId = accountIds[0]!;
      const id = await app.host.adopt(model.Customer, sourceId);
      const customers = app.as(model.employee).objects.Customer;
      const initial = await customers.get(id, { select: ['name', 'website'] });

      assertFields(initial, ['name', 'website']);
      assert.equal(initial.data.name, 'Northwind');
      assert.equal(initial.data.website, 'https://example.com');
      console.log(
        'PASS verified org identity and seeded Account read through Relate',
      );
      await org.updateAccount(sourceId, 'Northwind Updated');
      const updated = await customers.get(id, {
        select: ['name'],
        refresh: true,
      });

      assertFields(updated, ['name']);
      assert.equal(updated.data.name, 'Northwind Updated');
      console.log('PASS upstream update appears on refresh');
      const denied = salesforce({
        credentials: { ...credentials, accessToken: 'invalid-session-token' },
        apiVersion: '67.0',
      }).resource('Account', { fields: ['Name'] });

      await assert.rejects(denied.identify({ signal }), SourceAccessDenied);
      console.log('PASS provider rejects invalid credentials as access denial');
      await org.deleteAccount(sourceId);
      assert.deepEqual(await connector.fetch(sourceId, { signal }), {
        state: 'deleted',
        providerAccountId,
      });
      assert.deepEqual(
        await customers.get(id, { select: ['name'], refresh: true }),
        { status: 'not-found' },
      );
      console.log('PASS affirmative soft deletion removes cached Customer');
    } finally {
      await app.close();
    }
  });
  console.log('PASS owned scratch org teardown');
} catch (error) {
  console.error(
    error instanceof Error ? error.message : 'Salesforce live suite failed',
  );
  process.exitCode = 1;
}
