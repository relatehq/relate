import { createPostgresStore } from '@relate/postgres';
import { testDatabaseUrl } from '../support/database.js';
import {
  activityContract,
  lineageContract,
} from '../support/activity-contract.js';

function open() {
  const store = createPostgresStore({ connectionString: testDatabaseUrl() });

  return store.migrate().then(() => store);
}

activityContract('Postgres activity', async () => {
  const store = await open();

  return { store, close: () => store.close(), reopen: open };
});

lineageContract('Postgres operation lineage', async () => {
  const store = await open();

  return { store, close: () => store.close() };
});
