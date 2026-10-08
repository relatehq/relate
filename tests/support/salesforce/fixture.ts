import { salesforce } from '@relate/connector-salesforce';

export const orgId = '00D000000000001EAA';
export const accountId = '001000000000001AAA';

export const row = () => ({
  attributes: { type: 'Account' },
  Id: accountId,
  IsDeleted: false,
  Name: 'Northwind',
  Website: null,
});

export const queryResult = (records: unknown[] = [row()]) => ({
  records,
  totalSize: records.length,
  done: true,
});

/** A connector over an in-memory Salesforce transport the test can steer. */
export function fixture() {
  let organization = orgId;
  let result: unknown = queryResult();
  let status = 200;
  const transport: typeof fetch = async (url) =>
    String(url).endsWith('/userinfo')
      ? Response.json({ organization_id: organization })
      : Response.json(result, { status });

  return {
    resource: salesforce({
      credentials: {
        instanceUrl: 'https://fixture.my.salesforce.com',
        accessToken: 'test-secret',
      },
      apiVersion: '67.0',
      fetch: transport,
    }).resource('Account', { fields: ['Name', 'Website'] }),
    setOrg: (value: string) => {
      organization = value;
    },
    respond: (value: unknown, code = 200) => {
      result = value;
      status = code;
    },
  };
}
