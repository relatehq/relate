import { createPostgresStore } from '@relate/postgres';
import { fieldEvidenceContract } from '../support/field-evidence-contract.js';
import { testDatabaseUrl } from '../support/database.js';

fieldEvidenceContract('Postgres field evidence', async () => {
  const store = createPostgresStore({ connectionString: testDatabaseUrl() });

  await store.migrate();

  return { store, close: () => store.close() };
});
