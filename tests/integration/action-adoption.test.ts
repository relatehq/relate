import { createPostgresStore } from '@relate/postgres';
import { adoptionActionContract } from '../support/adoption-action-contract.js';
import { testDatabaseUrl } from '../support/database.js';

adoptionActionContract('Postgres action adoption', async () => {
  const store = createPostgresStore({ connectionString: testDatabaseUrl() });

  await store.migrate();

  let closed = false;

  return {
    store,
    kind: 'postgres',
    async close() {
      if (!closed) {
        closed = true;
        await store.close();
      }
    },
    async reopen() {
      const reconnected = createPostgresStore({
        connectionString: testDatabaseUrl(),
      });

      await reconnected.migrate();

      return reconnected;
    },
  };
});
