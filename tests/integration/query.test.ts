import { createPostgresStore } from '@relate/postgres';
import { queryContract } from '../support/query-contract.js';
import { testDatabaseUrl } from '../support/database.js';

queryContract('Postgres graph query', async () => {
  const store = createPostgresStore({ connectionString: testDatabaseUrl() });

  await store.migrate();

  return { store, close: () => store.close() };
});
