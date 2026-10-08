import { constraintActionContract } from '../support/constraint-action-contract.js';
import { createPostgresStore } from '@relate/postgres';
import { domainActionContract } from '../support/domain-action-contract.js';
import { nativeActionContract } from '../support/native-action-contract.js';
import { testDatabaseUrl } from '../support/database.js';

for (const contract of [
  nativeActionContract,
  domainActionContract,
  constraintActionContract,
])
  contract('Postgres native actions', async () => {
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
