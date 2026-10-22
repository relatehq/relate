import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { bind, defineApp, implementAction } from 'relate';
import { sqlite } from '@relate/connector-sqlite';
import { startCrmSimulator } from '@relate/dev-crm-simulator';
import { crmConnector } from './crm-connector.js';
import {
  graph,
  AddAccountReview,
  crmCustomers,
  billingInvoices,
} from './graph.js';

/** Server-owned demo actors: the graph's development principals with their IDs. */
export const actors = {
  ana: { id: 'ana', ...graph.principals.ana },
  fin: { id: 'fin', ...graph.principals.fin },
};

const addAccountReview = implementAction(
  graph,
  AddAccountReview,
  async ({ actor, input, objects }) => {
    const customer = await objects.Customer.get(input.customer, {
      select: ['id'],
    });

    if (customer.status !== 'ok') throw new Error('Customer unavailable');

    const review = await objects.AccountReview.create({
      customer: customer.id,
      author: actor.id,
      note: input.note,
    });

    return { reviewId: review.id };
  },
);

/** Each start owns its CRM simulator, temporary billing database and memory store. */
export const app = defineApp({
  graph,
  async setup({ onDispose }) {
    const directory = await mkdtemp(join(tmpdir(), 'relate-workspace-'));

    onDispose(() => rm(directory, { recursive: true, force: true }));
    const path = join(directory, 'billing.sqlite');
    const seed = new DatabaseSync(path);

    try {
      seed.exec(`CREATE TABLE invoices (id TEXT PRIMARY KEY, crm_customer_id TEXT NOT NULL, total_minor INTEGER NOT NULL, currency TEXT NOT NULL, status TEXT NOT NULL);
        INSERT INTO invoices VALUES ('INV-1042', 'crm_456', 480000, 'GBP', 'Overdue'), ('INV-1043', 'crm_456', 125000, 'GBP', 'Paid');`);
    } finally {
      seed.close();
    }

    const crm = await startCrmSimulator();

    onDispose(() => crm.stop());
    await crm.update({ status: 'active' });
    const billing = sqlite({ connectionId: 'demo-billing', path });

    onDispose(() => billing.close());

    return {
      graphId: 'customer-workspace',
      actionImplementations: [addAccountReview],
      bindings: [
        bind(crmCustomers, {
          connectionId: 'demo-crm',
          resourceId: 'records',
          providerAccountId: 'example-account',
          connector: crmConnector(crm.url),
        }),
        bind(billingInvoices, billing.table('invoices')),
      ],
    };
  },
});
