/** Sample records, simulated connectors and principals used only by validation. */
import { connect } from './target.js';
import type { Principal } from './target.js';
import { access } from '../source/access.js';
import { createApp } from '../source/app.js';
import { billingInvoices, crmCustomers } from '../source/model.js';
import { customers, invoices } from './records.js';

const lookup = <R>(records: Record<string, R>) => ({
  async fetch(sourceRecordId: string) {
    const record = records[sourceRecordId];

    return record
      ? { state: 'present' as const, record }
      : { state: 'deleted' as const };
  },
});

export const createFixtureApp = () =>
  createApp([
    connect(crmCustomers, {
      connectionId: 'crm-account-north',
      connector: lookup(customers),
    }),
    connect(billingInvoices, {
      connectionId: 'billing-primary',
      connector: lookup(invoices),
    }),
  ]);

// Hosts build these from an authenticated session, never from a request body.
export const ana: Principal<typeof access> = {
  id: 'ana',
  roles: ['employee', 'account-manager'],
  claims: { organization: 'org_north' },
};

export const fin: Principal<typeof access> = {
  id: 'fin',
  roles: ['employee', 'finance'],
  claims: { organization: 'org_north' },
};
