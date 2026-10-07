import { createPostgresStore } from '@relate/postgres';
import { nativeActionContract } from '../support/native-action-contract.js';
import { testDatabaseUrl } from '../support/database.js';

nativeActionContract('Postgres native actions', async () => {
  const store = createPostgresStore({ connectionString: testDatabaseUrl() });

  await store.migrate();

  let closed = false;

  return {
    store,
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
