import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { bind, defineApp, implementAction, type ObjectId } from 'relate';
import { startApp } from '@relate/node';
import { sqlite } from '@relate/connector-sqlite';
import { startCrmSimulator } from '@relate/dev-crm-simulator';
import { crmConnector } from './crm-connector.js';
import { seed } from './seed.js';
import {
  graph,
  AddAccountReview,
  AccountReview,
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

type CrmSimulator = Awaited<ReturnType<typeof startCrmSimulator>>;

/**
 * The workspace application. Each start owns a temporary billing database, a
 * CRM simulator and an isolated Relate memory store. `onCrm` hands the running
 * simulator to a host that edits CRM records, as the browser demo does.
 */
export function createWorkspaceApp(
  options: { readonly onCrm?: (crm: CrmSimulator) => void } = {},
) {
  return defineApp({
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
      options.onCrm?.(crm);
      const billing = sqlite({ path });

      onDispose(() => billing.close());

      return {
        graphId: 'customer-workspace',
        actionImplementations: [addAccountReview],
        bindings: [
          bind(crmCustomers, {
            connectionId: 'demo-crm',
            providerAccountId: 'example-account',
            connector: crmConnector(crm.url),
          }),
          bind(billingInvoices, {
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
}

/** The default export of `relate.config.ts`: `relate dev` runs it as its runtime. */
export const app = createWorkspaceApp();

/** The browser demo's own runtime, with seed records adopted. */
export async function startWorkspace() {
  let crm!: CrmSimulator;
  const relate = await startApp(
    createWorkspaceApp({ onCrm: (started) => (crm = started) }),
  );

  // Temporary demo index, not the contents of CustomerReviews: reviews created
  // outside this wrapper are not enumerated. Values are still read through Relate.
  // TODO(native-reference traversal): replace with
  // `objects.Customer.traverse.reviews(customerId)` and drop this index, the
  // UI's "Temporary demo list" hint and the matching README paragraph.
  const reviewIds = new Set<ObjectId<typeof AccountReview.id>>();

  try {
    const { customerId } = await seed(relate);

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
