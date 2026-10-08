import { expect, it } from 'vitest';
import { SourceAccessDenied } from 'relate/connectors';
import { startCrmSimulator } from '../../dev/simulators/crm/index.js';
import { crmConnector } from '../../examples/postgres-persistence/src/connector.js';

it('isolates instances and preserves HTTP updates, denial, deletion, and source outages', async () => {
  const first = await startCrmSimulator();
  const second = await startCrmSimulator();
  const connector = crmConnector(first.url);
  const read = () =>
    connector.fetch('crm_456', { signal: new AbortController().signal });

  try {
    expect(await read()).toMatchObject({
      state: 'present',
      record: { display_name: 'Northwind' },
      version: { domain: 'crm-v1', value: '1' },
    });
    await first.update({ display_name: 'Changed' });
    expect(await read()).toMatchObject({
      record: { display_name: 'Changed' },
      version: { value: '2' },
    });
    expect(
      await (await fetch(`${second.url}/customers/crm_456`)).json(),
    ).toMatchObject({
      record: { display_name: 'Northwind' },
      version: { value: '1' },
    });
    expect((await fetch(`${first.url}/customers/missing`)).status).toBe(404);
    first.setAccess('denied');
    expect((await fetch(`${first.url}/customers/crm_456`)).status).toBe(403);
    await expect(read()).rejects.toBeInstanceOf(SourceAccessDenied);
    first.setAccess('granted');
    expect(await read()).toMatchObject({ record: { display_name: 'Changed' } });
    await first.update({}, true);
    expect(await read()).toEqual({
      providerAccountId: 'example-account',
      state: 'deleted',
      version: { domain: 'crm-v1', value: '3' },
    });
    await first.stop();
    await expect(read()).rejects.toThrow();
    await first.stop();
  } finally {
    await Promise.all([first.stop(), second.stop()]);
  }
});
