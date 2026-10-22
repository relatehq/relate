import { bind, defineApp } from 'relate';
import { createPostgresStore } from '@relate/postgres';
import { startCrmSimulator } from '@relate/dev-crm-simulator';
import { customerGraph, customers } from './model.js';
import { crmConnector } from './connector.js';

export const app = defineApp({
  graph: customerGraph,
  async setup({ onDispose }) {
    const databaseUrl = process.env.DATABASE_URL;

    if (!databaseUrl)
      throw new Error(
        'Set DATABASE_URL to an existing Postgres database before running this example.',
      );

    const store = createPostgresStore({ connectionString: databaseUrl });

    onDispose(() => store.close());
    await store.migrate();
    const crm = await startCrmSimulator();

    onDispose(() => crm.stop());

    return {
      graphId: 'postgres-persistence',
      store,
      bindings: [
        bind(customers, {
          providerAccountId: 'example-account',
          connectionId: 'crm-primary',
          resourceId: 'records',
          connector: crmConnector(crm.url),
        }),
      ],
    };
  },
});
