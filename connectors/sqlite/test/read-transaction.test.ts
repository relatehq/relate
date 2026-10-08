import { DatabaseSync } from 'node:sqlite';
import { expect, test } from 'vitest';
import { readTransaction } from '../src/read-transaction.js';

test('preserves the statement error after SQLite automatically rolls back', () => {
  const db = new DatabaseSync(':memory:');

  try {
    db.exec(
      'CREATE TABLE items (id INTEGER PRIMARY KEY); INSERT INTO items VALUES (1)',
    );
    expect(() =>
      readTransaction(db, () =>
        db.exec('INSERT OR ROLLBACK INTO items VALUES (1)'),
      ),
    ).toThrow('UNIQUE constraint failed');
    expect(db.isTransaction).toBe(false);
    expect(
      readTransaction(db, () =>
        db.prepare('SELECT count(*) AS count FROM items').get(),
      ),
    ).toMatchObject({ count: 1 });
  } finally {
    db.close();
  }
});

test('retains the original error when rollback also fails', () => {
  const original = Object.assign(new Error('original I/O failure'), {
    errcode: 10,
  });
  const db = {
    isTransaction: true,
    exec(sql: string) {
      if (sql === 'ROLLBACK') throw new Error('cleanup failed');
    },
  };

  expect(() =>
    readTransaction(db, () => {
      throw original;
    }),
  ).toThrow(original);
  expect(() => readTransaction(db, () => 'success')).toThrow('cleanup failed');
});
