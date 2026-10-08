import { connect, defineApp } from 'relate';
import { sqlite } from '@relate/connector-sqlite';
import { customerGraph, customers } from './model.js';

export function customerAccounts(path: string) {
  return defineApp({
    graph: customerGraph,
    setup({ onDispose }) {
      const database = sqlite({
        path,
        identity: { table: 'account', column: 'id' },
      });

      onDispose(() => database.close());

      return {
        graphId: 'customer-accounts',
        connections: [
          connect(customers, {
            connectionId: 'local-crm',
            providerAccountId: 'demo-crm',
            connector: database.table('customers', {
              idColumn: 'id',
              columns: ['display_name', 'portfolio', 'stripe_customer_id'],
            }),
          }),
        ],
      };
    },
  });
}
