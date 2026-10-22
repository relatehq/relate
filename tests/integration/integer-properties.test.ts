import { createPostgresStore } from '@relate/postgres';
import { integerPropertyContract } from '../support/integer-property-contract.js';
import { testDatabaseUrl } from '../support/database.js';

integerPropertyContract('Postgres integers', async () => {
  const store = createPostgresStore({ connectionString: testDatabaseUrl() });

  await store.migrate();

  return { store, close: () => store.close() };
});
