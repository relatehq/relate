import { salesforce } from '@relate/connector-salesforce';
import { advertisers, salesforceOrgId } from './data.js';

/**
 * An in-process stand-in for a Salesforce org: it answers the two REST calls the
 * connector makes, so the example needs no org, credentials or network. To use a
 * real org, pass your own credentials and omit `fetch`.
 */
const transport: typeof fetch = async (input) => {
  const url = new URL(String(input));

  if (url.pathname === '/services/oauth2/userinfo')
    return Response.json({ organization_id: salesforceOrgId });

  const id = /WHERE Id = '([A-Za-z0-9]+)'/.exec(
    url.searchParams.get('q') ?? '',
  )?.[1];
  const records = advertisers
    .filter(([accountId]) => accountId === id)
    .map(([Id, Name, Industry, Team__c]) => ({
      attributes: { type: 'Account' },
      Id,
      IsDeleted: false,
      Name,
      Industry,
      Team__c,
    }));

  return Response.json({ records, totalSize: records.length, done: true });
};

export const simulatedSalesforce = () =>
  salesforce({
    connectionId: 'salesforce-crm',
    credentials: {
      instanceUrl: 'https://ad-network.my.salesforce.com',
      accessToken: 'example-token',
    },
    apiVersion: '67.0',
    fetch: transport,
  });
