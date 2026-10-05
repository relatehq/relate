import { createPostgresStore } from '@relate/postgres';
import { testDatabaseUrl } from '../support/database.js';
import { storeContract } from '../support/store-contract.js';

const databaseUrl = testDatabaseUrl();

storeContract('Postgres store contract', async () => {
  const store = createPostgresStore({ connectionString: databaseUrl });

  await store.migrate();

  return { store, close: () => store.close() };
});
