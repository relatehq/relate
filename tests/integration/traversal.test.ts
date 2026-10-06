import { createPostgresStore } from '@relate/postgres';
import { traversalContract } from '../support/traversal-contract.js';
import { testDatabaseUrl } from '../support/database.js';

traversalContract('Postgres traversal', async () => {
  const store = createPostgresStore({ connectionString: testDatabaseUrl() });

  await store.migrate();

  return { store, close: () => store.close() };
});
