import pg from 'pg';
import { testDatabaseUrl } from './database.js';

export default async function setup() {
  const connectionString = testDatabaseUrl();
  const reset = async () => {
    const client = new pg.Client({ connectionString });

    try {
      await client.connect();
      await client.query('DROP SCHEMA IF EXISTS relate CASCADE');
    } finally {
      await client.end();
    }
  };

  await reset();

  return reset;
}
