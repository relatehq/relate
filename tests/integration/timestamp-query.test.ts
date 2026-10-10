import { createPostgresStore } from '@relate/postgres';
import { timestampQueryContract } from '../support/timestamp-query-contract.js';
import { testDatabaseUrl } from '../support/database.js';

timestampQueryContract('Postgres timestamp queries', async () => {
  const store = createPostgresStore({ connectionString: testDatabaseUrl() });

  await store.migrate();

  return { store, close: () => store.close() };
});
