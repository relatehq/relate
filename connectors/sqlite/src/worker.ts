import { DatabaseSync } from 'node:sqlite';
import type { StatementSync } from 'node:sqlite';
import { parentPort, workerData } from 'node:worker_threads';
import { SourceAccessDenied } from 'relate/connectors';
import type { SourceRecord } from 'relate/connectors';
import { identifier } from './contracts.js';
import type { Request, Response, WorkerSettings } from './contracts.js';
import { readTransaction } from './read-transaction.js';

const options = workerData as WorkerSettings;
let db: DatabaseSync | undefined;
let identity: StatementSync | undefined;
const statements = new Map<string, StatementSync>();

function database(): DatabaseSync {
  return (db ??= new DatabaseSync(options.path, {
    readOnly: true,
    enableDoubleQuotedStringLiterals: false,
    allowExtension: false,
    timeout: options.busyTimeoutMs,
  }));
}

function account(connection: DatabaseSync): string {
  identity ??= connection.prepare(
    `SELECT ${identifier(options.identity.column)} AS account FROM ${identifier(options.identity.table)} LIMIT 2`,
  );
  const rows = identity.all();
  const id = rows[0]?.account;

  if (rows.length !== 1 || typeof id !== 'string' || !id.trim())
    throw new SourceAccessDenied();

  if (id !== id.trim()) {
    const error = new SourceAccessDenied();

    error.message =
      'SQLite account ID must not have leading or trailing whitespace';
    throw error;
  }

  return id;
}

function execute(request: Request): string | SourceRecord {
  const connection = database();

  return readTransaction(connection, () => {
    const providerAccountId = account(connection);

    if (request.operation === 'identify') return providerAccountId;

    const { idColumn, columns } = request.options;
    const names = [idColumn, ...columns.filter((name) => name !== idColumn)];
    // Explicit aliases preserve configured identifier casing in the returned record.
    const projection = names
      .map((name) => `${identifier(name)} AS ${identifier(name)}`)
      .join(', ');
    const key = identifier(idColumn);
    // Exact TEXT equality is part of the source identity contract, irrespective of
    // the provider column's declared affinity or collation. Filter before LIMIT.
    const sql = `SELECT ${projection} FROM ${identifier(request.table)} WHERE ${key} = ? COLLATE BINARY AND typeof(${key}) = 'text' LIMIT 2`;
    let statement = statements.get(sql);

    if (!statement) {
      statement = connection.prepare(sql);
      statements.set(sql, statement);
    }

    const rows = statement.all(request.recordId);

    if (rows.length > 1) throw new Error('SQLite source key is not unique');

    const row = rows[0];

    // Inspect after stepping: SQLite may have automatically recompiled a cached
    // statement after a schema change. Numeric affinity is incompatible with TEXT IDs.
    const declaredType = statement.columns()[0]?.type?.toUpperCase() ?? '';

    if (
      declaredType.includes('INT') ||
      (declaredType !== '' &&
        !['CHAR', 'CLOB', 'TEXT', 'BLOB'].some((name) =>
          declaredType.includes(name),
        ))
    )
      throw new Error('SQLite source key column must support TEXT IDs');

    if (!row) {
      // Untyped columns and views can change storage class without a schema change.
      // Only affirm absence when the resource does not contain invalid key values.
      const invalidSql = `SELECT 1 FROM ${identifier(request.table)} WHERE typeof(${key}) != 'text' LIMIT 1`;
      let invalid = statements.get(invalidSql);

      if (!invalid) {
        invalid = connection.prepare(invalidSql);
        statements.set(invalidSql, invalid);
      }

      if (invalid.get())
        throw new Error('SQLite source key contains non-TEXT values');

      return { providerAccountId, state: 'deleted' };
    }

    const entries: [string, string | number | null][] = [];

    for (const [name, value] of Object.entries(row)) {
      if (
        value === null ||
        typeof value === 'string' ||
        (typeof value === 'number' && Number.isFinite(value))
      )
        entries.push([name, value]);
      else throw new Error(`SQLite column ${name} is not a JSON scalar`);
    }

    return {
      providerAccountId,
      state: 'present',
      record: Object.fromEntries(entries),
    };
  });
}

parentPort!.on('message', (request: Request) => {
  let response: Response;

  try {
    response = { id: request.id, ok: true, result: execute(request) };
  } catch (error) {
    const cause = error as Error & { code?: string; errcode?: number };

    response = {
      id: request.id,
      ok: false,
      error: {
        message: cause.message,
        denied: error instanceof SourceAccessDenied,
        ...(cause.code === undefined ? {} : { code: cause.code }),
        ...(cause.errcode === undefined ? {} : { errcode: cause.errcode }),
      },
    };

    // If rollback itself failed, discard the connection rather than reusing a
    // poisoned transaction on the next request. Keep the original error above.
    if (db?.isTransaction) {
      try {
        db.close();
      } catch {
        /* Preserve the operation error. */
      }

      db = undefined;
      identity = undefined;
      statements.clear();
    }
  }

  parentPort!.postMessage(response);
});
