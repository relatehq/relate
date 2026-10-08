import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, expect, test } from 'vitest';
import { sqlite } from '@relate/connector-sqlite';
import { SourceAccessDenied } from 'relate/connectors';
import { seed } from '../../../examples/customer-accounts/src/seed.js';

const cleanups: (() => void | Promise<void>)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.reverse()) await cleanup();

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
  const connector = database.table('customers', {
    idColumn: 'id',
    columns: ['display_name', 'portfolio', 'stripe_customer_id'],
  });

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
  const quoted = connection.table('odd"table', {
    idColumn: 'key"column',
    columns: ['value'],
  });

  try {
    expect(await quoted.fetch('one', request())).toMatchObject({
      record: { 'key"column': 'one', value: 1.5 },
    });
  } finally {
    await connection.close();
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

test('does not read or retain undeclared columns; rejects invalid selected values', async () => {
  const { db, connector, database } = fixture();

  db.exec(
    "ALTER TABLE customers ADD COLUMN secret; ALTER TABLE customers ADD COLUMN avatar BLOB; ALTER TABLE customers ADD COLUMN external_id INTEGER; UPDATE customers SET secret = 'private', avatar = x'ffff', external_id = 9223372036854775807",
  );
  expect(await connector.fetch('crm_northwind', request())).toMatchObject({
    state: 'present',
  });
  const result = await connector.fetch('crm_northwind', request());

  if (result.state !== 'present') throw new Error('Expected record');

  expect(Object.keys(result.record).sort()).toEqual([
    'display_name',
    'id',
    'portfolio',
    'stripe_customer_id',
  ]);
  await expect(
    database
      .table('customers', { idColumn: 'id', columns: ['avatar'] })
      .fetch('crm_northwind', request()),
  ).rejects.toThrow('JSON scalar');
  await expect(
    database
      .table('customers', { idColumn: 'id', columns: ['external_id'] })
      .fetch('crm_northwind', request()),
  ).rejects.toThrow();
  db.exec('UPDATE customers SET secret = 1e999');
  await expect(
    database
      .table('customers', { idColumn: 'id', columns: ['secret'] })
      .fetch('crm_northwind', request()),
  ).rejects.toThrow('JSON scalar');
});

test('aliases configured identifier casing and checks uniqueness only among exact TEXT IDs', async () => {
  const { db, database } = fixture();
  const uppercase = database.table('customers', {
    idColumn: 'ID',
    columns: ['DISPLAY_NAME'],
  });

  expect(await uppercase.fetch('crm_northwind', request())).toMatchObject({
    record: { ID: 'crm_northwind', DISPLAY_NAME: 'Northwind' },
  });
  db.exec(
    "CREATE TABLE mixed (id COLLATE NOCASE, name TEXT); INSERT INTO mixed VALUES ('abc', 'lower'), ('ABC', 'upper'), (1, 'integer'), ('1', 'text')",
  );
  const resource = database.table('mixed', {
    idColumn: 'id',
    columns: ['name'],
  });

  expect(await resource.fetch('abc', request())).toMatchObject({
    record: { name: 'lower' },
  });
  expect(await resource.fetch('ABC', request())).toMatchObject({
    record: { name: 'upper' },
  });
  expect(await resource.fetch('1', request())).toMatchObject({
    record: { name: 'text' },
  });
  db.exec("INSERT INTO mixed VALUES ('abc', 'duplicate')");
  await expect(resource.fetch('abc', request())).rejects.toThrow('not unique');
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
  await database.close();
  await database.close();
  await expect(connector.identify(request())).rejects.toThrow('closed');
});

test('shares identity and lifecycle across table resources', async () => {
  const { db, connector, database } = fixture();

  db.exec(
    "CREATE TABLE notes (key TEXT PRIMARY KEY, body TEXT); INSERT INTO notes VALUES ('note_1', 'Call back')",
  );
  const notes = database.table('notes', { idColumn: 'key', columns: ['body'] });

  expect(await notes.fetch('note_1', request())).toMatchObject({
    providerAccountId: 'demo-crm',
    record: { key: 'note_1', body: 'Call back' },
  });
  expect(await connector.identify(request())).toBe(
    await notes.identify(request()),
  );
  await database.close();
  await expect(notes.fetch('note_1', request())).rejects.toThrow('closed');
});

test('waits for a brief writer lock without blocking JavaScript timers', async () => {
  const { db, connector } = fixture();

  await connector.identify(request());
  db.exec('BEGIN EXCLUSIVE');
  const release = setTimeout(() => db.exec('ROLLBACK'), 30);

  try {
    expect(await connector.fetch('crm_northwind', request())).toMatchObject({
      state: 'present',
    });
    expect(db.isTransaction).toBe(false);
  } finally {
    clearTimeout(release);

    if (db.isTransaction) db.exec('ROLLBACK');
  }
});

test('cancels queued requests without cancelling another resource read', async () => {
  const { db, connector } = fixture();

  await connector.identify(request());
  db.exec('BEGIN EXCLUSIVE');
  const first = connector.fetch('crm_northwind', request());
  const controller = new AbortController();
  const cancelled = connector.identify({ signal: controller.signal });
  const rejection = expect(cancelled).rejects.toThrow('queued cancellation');

  controller.abort(new Error('queued cancellation'));
  await rejection;
  db.exec('ROLLBACK');
  expect(await first).toMatchObject({ state: 'present' });
  expect(await connector.identify(request())).toBe('demo-crm');
});

test('a running slow query does not block its deadline, and the connection recovers', async () => {
  const { db, connector, database } = fixture();

  db.exec(
    "CREATE VIEW expensive AS WITH RECURSIVE numbers(x) AS (VALUES(0) UNION ALL SELECT x + 1 FROM numbers WHERE x < 3000000) SELECT 'slow' AS id, sum(x) AS total FROM numbers",
  );
  await connector.identify(request());
  const slow = database.table('expensive', {
    idColumn: 'id',
    columns: ['total'],
  });
  const controller = new AbortController();
  const start = performance.now();
  const timer = setTimeout(
    () => controller.abort(new Error('query deadline')),
    20,
  );

  try {
    await expect(
      slow.fetch('slow', { signal: controller.signal }),
    ).rejects.toThrow('query deadline');
    expect(performance.now() - start).toBeLessThan(300);
    expect(await connector.identify(request())).toBe('demo-crm');
  } finally {
    clearTimeout(timer);
  }
});

test('close rejects active and queued reads and is safe to await twice', async () => {
  const { db, connector, database } = fixture();

  await connector.identify(request());
  db.exec('BEGIN EXCLUSIVE');

  try {
    const active = expect(
      connector.fetch('crm_northwind', request()),
    ).rejects.toThrow('closed');
    const queued = expect(connector.identify(request())).rejects.toThrow(
      'closed',
    );

    await database.close();
    await Promise.all([active, queued]);
    await database.close();
  } finally {
    db.exec('ROLLBACK');
  }
});

test('missing files reject on first use without claiming provider denial', async () => {
  const { path } = fixture();
  const database = sqlite({
    path: `${path}.missing`,
    identity: { table: 'account', column: 'id' },
  });

  try {
    const resource = database.table('customers', {
      idColumn: 'id',
      columns: [],
    });
    const error = await resource
      .identify(request())
      .catch((error: unknown) => error);

    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(SourceAccessDenied);
    expect(error).toMatchObject({ errcode: 14 });
  } finally {
    await database.close();
  }
});
