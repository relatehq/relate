import { createPostgresStore } from '@relate/postgres';
import { receiptRecoveryContract } from '../support/receipt-recovery-contract.js';
import { testDatabaseUrl } from '../support/database.js';

receiptRecoveryContract('Postgres receipt recovery', async () => {
  const store = createPostgresStore({ connectionString: testDatabaseUrl() });

  await store.migrate();

  return { store, close: () => store.close() };
});
