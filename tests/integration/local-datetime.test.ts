import { createPostgresStore } from '@relate/postgres';
import { localDateTimeContract } from '../support/local-datetime-contract.js';
import { testDatabaseUrl } from '../support/database.js';

localDateTimeContract('Postgres local datetime', async () => {
  const store = createPostgresStore({ connectionString: testDatabaseUrl() });

  await store.migrate();

  return { store, close: () => store.close() };
});
