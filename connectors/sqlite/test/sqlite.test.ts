import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, expect, test } from 'vitest';
import { sqlite } from '@relate/connector-sqlite';
import { SourceAccessDenied } from 'relate/connectors';
import { seed } from '../../../examples/customer-accounts/src/seed.js';

const cleanups: (() => void)[] = [];

afterEach(() => {
  for (const cleanup of cleanups.reverse()) cleanup();

  cleanups.length = 0;
});
const request = () => ({ signal: new AbortController().signal });

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'relate-sqlite-test-'));
  const path = join(directory, 'crm.sqlite');

  cleanups.push(() => rmSync(directory, { recursive: true, force: true }));
  seed(path);
  const db = new DatabaseSync(path);

  cleanups.push(() => db.close());
  const database = sqlite({
    path,
    identity: { table: 'account', column: 'id' },
  });
  const connector = database.table('customers', { idColumn: 'id' });

  cleanups.push(() => database.close());

  return { path, db, connector, database };
}

test('reads database identity, scalar values, updates and affirmative absence', async () => {
  const { db, connector } = fixture();

  expect(await connector.identify(request())).toBe('demo-crm');
  expect(await connector.fetch('crm_northwind', request())).toEqual({
    providerAccountId: 'demo-crm',
    state: 'present',
    record: {
      id: 'crm_northwind',
      display_name: 'Northwind',
      portfolio: 'portfolio_north',
      stripe_customer_id: 'cus_demo_northwind',
    },
  });
  db.exec(
    "UPDATE customers SET display_name = 'Updated', stripe_customer_id = NULL WHERE id = 'crm_northwind'",
  );
  expect(await connector.fetch('crm_northwind', request())).toMatchObject({
    record: { display_name: 'Updated', stripe_customer_id: null },
  });
  db.exec("DELETE FROM customers WHERE id = 'crm_northwind'");
  expect(await connector.fetch('crm_northwind', request())).toEqual({
    providerAccountId: 'demo-crm',
    state: 'deleted',
  });
  db.exec('DROP TABLE customers');
  await expect(connector.fetch('crm_northwind', request())).rejects.toThrow();
});

test('binds IDs and quotes identifiers without executing input as SQL', async () => {
  const { path, db, connector } = fixture();
  const id = "x' OR 1=1 --";

  expect(await connector.fetch(id, request())).toMatchObject({
    state: 'deleted',
  });
  db.prepare('INSERT INTO customers VALUES (?, ?, ?, ?)').run(
    id,
    'Literal',
    'portfolio_north',
    null,
  );
  expect(await connector.fetch(id, request())).toMatchObject({
    record: { id, display_name: 'Literal' },
  });
  db.exec(
    'CREATE TABLE "odd""table" ("key""column" TEXT PRIMARY KEY, value REAL); INSERT INTO "odd""table" VALUES (\'one\', 1.5)',
  );
  const connection = sqlite({
    path,
    identity: { table: 'account', column: 'id' },
  });
  const quoted = connection.table('odd"table', { idColumn: 'key"column' });

  try {
    expect(await quoted.fetch('one', request())).toMatchObject({
      record: { 'key"column': 'one', value: 1.5 },
    });
  } finally {
    connection.close();
  }
});

test('does not cache identity, and rejects missing or ambiguous account evidence', async () => {
  const { db, connector } = fixture();

  db.exec("UPDATE account SET id = 'other-account'");
  expect(await connector.identify(request())).toBe('other-account');
  expect(await connector.fetch('missing', request())).toMatchObject({
    providerAccountId: 'other-account',
  });
  db.exec("INSERT INTO account VALUES ('second')");
  await expect(connector.identify(request())).rejects.toBeInstanceOf(
    SourceAccessDenied,
  );
  await expect(
    connector.fetch('crm_northwind', request()),
  ).rejects.toBeInstanceOf(SourceAccessDenied);
  db.exec('DELETE FROM account');
  await expect(connector.identify(request())).rejects.toBeInstanceOf(
    SourceAccessDenied,
  );
});

test('rejects ambiguous keys, non-JSON values and lossy integers', async () => {
  const { db, connector } = fixture();

  db.exec(
    "ALTER TABLE customers ADD COLUMN extra; UPDATE customers SET extra = x'ffff'",
  );
  await expect(connector.fetch('crm_northwind', request())).rejects.toThrow(
    'JSON scalar',
  );
  db.exec('UPDATE customers SET extra = 9223372036854775807');
  await expect(connector.fetch('crm_northwind', request())).rejects.toThrow();
  db.exec('UPDATE customers SET extra = 1e999');
  await expect(connector.fetch('crm_northwind', request())).rejects.toThrow(
    'JSON scalar',
  );
  db.exec(
    "DROP TABLE customers; CREATE TABLE customers (id TEXT); INSERT INTO customers VALUES ('same'), ('same')",
  );
  await expect(connector.fetch('same', request())).rejects.toThrow(
    'not unique',
  );
  db.exec(
    'DROP TABLE customers; CREATE TABLE customers (id INTEGER); INSERT INTO customers VALUES (1)',
  );
  await expect(connector.fetch('1', request())).rejects.toThrow('TEXT ID');
});

test('honors cancellation, lock failures and owned connection disposal', async () => {
  const { db, connector, database } = fixture();
  const controller = new AbortController();

  controller.abort(new Error('cancelled'));
  await expect(
    connector.fetch('crm_northwind', { signal: controller.signal }),
  ).rejects.toThrow('cancelled');
  db.exec('BEGIN EXCLUSIVE');

  try {
    await expect(connector.fetch('crm_northwind', request())).rejects.toThrow();
  } finally {
    db.exec('ROLLBACK');
  }

  expect(await connector.identify(request())).toBe('demo-crm');
  database.close();
  database.close();
  await expect(connector.identify(request())).rejects.toThrow('closed');
});

test('shares identity and lifecycle across table resources', async () => {
  const { db, connector, database } = fixture();

  db.exec(
    "CREATE TABLE notes (key TEXT PRIMARY KEY, body TEXT); INSERT INTO notes VALUES ('note_1', 'Call back')",
  );
  const notes = database.table('notes', { idColumn: 'key' });

  expect(await notes.fetch('note_1', request())).toMatchObject({
    providerAccountId: 'demo-crm',
    record: { key: 'note_1', body: 'Call back' },
  });
  expect(await connector.identify(request())).toBe(
    await notes.identify(request()),
  );
  database.close();
  await expect(notes.fetch('note_1', request())).rejects.toThrow('closed');
});
