import { createPostgresStore } from '@relate/postgres';
import { propertyIdentityContract } from '../support/property-identity-contract.js';
import { testDatabaseUrl } from '../support/database.js';

propertyIdentityContract('Postgres property identity', async () => {
  const store = createPostgresStore({ connectionString: testDatabaseUrl() });

  await store.migrate();

  return { store, close: () => store.close() };
});
