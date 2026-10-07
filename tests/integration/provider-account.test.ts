import { createPostgresStore } from '@relate/postgres';
import { providerAccountContract } from '../support/provider-account-contract.js';
import { testDatabaseUrl } from '../support/database.js';

providerAccountContract('Postgres provider account isolation', async () => {
  const store = createPostgresStore({ connectionString: testDatabaseUrl() });

  await store.migrate();

  return { store, close: () => store.close() };
});
