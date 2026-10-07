import { createPostgresStore } from '@relate/postgres';
import { deletedReferenceContract } from '../support/deleted-reference-contract.js';
import { testDatabaseUrl } from '../support/database.js';

deletedReferenceContract('Postgres deleted references', async () => {
  const store = createPostgresStore({ connectionString: testDatabaseUrl() });

  await store.migrate();

  return { store, close: () => store.close() };
});
