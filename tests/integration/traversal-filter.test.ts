import { createPostgresStore } from '@relate/postgres';
import { traversalFilterContract } from '../support/traversal-filter-contract.js';
import { testDatabaseUrl } from '../support/database.js';

traversalFilterContract('Postgres traversal filters', async () => {
  const store = createPostgresStore({ connectionString: testDatabaseUrl() });

  await store.migrate();

  return { store, close: () => store.close() };
});
