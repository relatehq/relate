import { createPostgresStore } from '@relate/postgres';
import { invoiceReadContract } from '../support/invoice-read-contract.js';
import { testDatabaseUrl } from '../support/database.js';

invoiceReadContract('Postgres invoice reads', async () => {
  const store = createPostgresStore({ connectionString: testDatabaseUrl() });

  await store.migrate();

  return { store, close: () => store.close() };
});
