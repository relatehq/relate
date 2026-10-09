import { salesforce } from '@relate/connector-salesforce';
import type { SalesforceOptions } from '@relate/connector-salesforce';

export const orgId = '00D000000000001EAA';
export const accountId = '001000000000001AAA';
export const signal = () => new AbortController().signal;

export const credentials = {
  instanceUrl: 'https://fixture.my.salesforce.com',
  accessToken: 'test-secret',
};

export const row = () => ({
  attributes: { type: 'Account' },
  Id: accountId,
  IsDeleted: false,
  Name: 'Northwind',
  Website: null,
  Secret: 'unselected',
});

export const queryResult = (records: unknown[] = [row()]) => ({
  records,
  totalSize: records.length,
  done: true,
});

export function fixture(overrides: Partial<SalesforceOptions> = {}) {
  let organization = orgId;
  let result: unknown = queryResult();
  let status = 200;
  const calls: { url: string; init: RequestInit | undefined }[] = [];
  const transport: typeof fetch = async (url, init) => {
    calls.push({ url: String(url), init });

    return String(url).endsWith('/userinfo')
      ? Response.json({ organization_id: organization })
      : Response.json(result, { status });
  };
  const connection = salesforce({
    credentials,
    apiVersion: '67.0',
    fetch: transport,
    ...overrides,
  });

  return {
    connection,
    calls,
    resource: connection.resource('Account', { fields: ['Name', 'Website'] }),
    setOrg: (value: string) => {
      organization = value;
    },
    respond: (value: unknown, code = 200) => {
      result = value;
      status = code;
    },
  };
}
