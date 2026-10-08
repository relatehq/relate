import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { connect, defineApp, implementAction, type ObjectId } from 'relate';
import { startApp } from '@relate/node';
import { sqlite } from '@relate/connector-sqlite';
import { startCrmSimulator } from '@relate/dev-crm-simulator';
import { crmConnector } from './crm-connector.js';
import {
  graph,
  AddAccountReview,
  Customer,
  Invoice,
  AccountReview,
  crmCustomers,
  billingInvoices,
} from './graph.js';

export const actors = {
  ana: {
    id: 'ana',
    roles: ['employee', 'account-manager'],
    claims: { portfolio: 'portfolio_north' },
  },
  fin: {
    id: 'fin',
    roles: ['employee', 'finance'],
    claims: { portfolio: 'portfolio_north' },
  },
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

/** Each launch owns a temporary billing database and an isolated Relate memory store. */
export async function startWorkspace() {
  let crm!: Awaited<ReturnType<typeof startCrmSimulator>>;
  const app = defineApp({
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

      crm = await startCrmSimulator();
      onDispose(() => crm.stop());
      await crm.update({ status: 'active' });
      const billing = sqlite({ path });

      onDispose(() => billing.close());

      return {
        graphId: 'customer-workspace',
        actionImplementations: [addAccountReview],
        connections: [
          connect(crmCustomers, {
            connectionId: 'demo-crm',
            providerAccountId: 'example-account',
            connector: crmConnector(crm.url),
          }),
          connect(billingInvoices, {
            connectionId: 'demo-billing',
            connector: billing.table('invoices', {
              idColumn: 'id',
              columns: ['crm_customer_id', 'total_minor', 'currency', 'status'],
            }),
          }),
        ],
      };
    },
  });
  const relate = await startApp(app);

  // Temporary demo index, not the contents of CustomerReviews: reviews created
  // outside this wrapper are not enumerated. Values are still read through Relate.
  // TODO(native-reference traversal): replace with
  // `objects.Customer.traverse.reviews(customerId)` and drop this index, the
  // UI's "Temporary demo list" hint and the matching README paragraph.
  const reviewIds = new Set<ObjectId<typeof AccountReview.id>>();

  try {
    // Adoption is a host operation. This seed is not a general source enumeration API.
    // TODO(source sync): adopt invoices from a SQLite scan instead of fixed IDs.
    const customerId = await relate.host.adopt(Customer, 'crm_456');

    await relate.host.adopt(Invoice, 'INV-1042');
    await relate.host.adopt(Invoice, 'INV-1043');

    return {
      relate,
      customerId,
      rename: (name: string) => crm.update({ display_name: name }),
      async read(actor: keyof typeof actors, refresh = false) {
        const { objects } = relate.as(actors[actor]);
        const customer = await objects.Customer.get(customerId, { refresh });
        const invoices = await objects.Customer.traverse.invoices(customerId, {
          select: ['id', 'status', 'totalMinor', 'currency'],
          refresh,
        });
        // Native-reference traversal is not implemented yet. Keep the IDs from
        // this demo's successful actions, then authorize every read through Relate.
        const results = await Promise.all(
          [...reviewIds].map((id) => objects.AccountReview.get(id)),
        );
        const reviews = {
          data: results.filter((result) => result.status === 'ok'),
        };

        return { customer, invoices, reviews };
      },
      async review(
        actor: keyof typeof actors,
        note: string,
        idempotencyKey: string,
      ) {
        const receipt = await relate
          .as(actors[actor])
          .actions.addAccountReview({
            input: { customer: customerId, note },
            idempotencyKey,
          });

        reviewIds.add(receipt.output.reviewId);

        return receipt;
      },
      close: () => relate.close(),
    };
  } catch (error) {
    await relate.close();
    throw error;
  }
}
