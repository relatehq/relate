import { createPostgresStore } from '@relate/postgres';
import { throughTraversalContract } from '../support/through-traversal-contract.js';
import { testDatabaseUrl } from '../support/database.js';

throughTraversalContract('Postgres through traversal', async () => {
  const store = createPostgresStore({ connectionString: testDatabaseUrl() });

  await store.migrate();

  return { store, close: () => store.close() };
});
