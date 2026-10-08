import { DatabaseSync } from 'node:sqlite';
import { SourceAccessDenied } from 'relate/connectors';
import type { SourceConnector, SourceRecord } from 'relate/connectors';

export interface SqliteOptions {
  /** Existing database file. The connector never creates or writes it. */
  readonly path: string;
  /** A singleton table containing the database's stable, nonempty TEXT account ID. */
  readonly identity: { readonly table: string; readonly column: string };
}

export interface SqliteConnection {
  /** Select a resource with a unique TEXT key matching the source idField. */
  table(name: string, options: { readonly idColumn: string }): SourceConnector;
  /** Release the owned connection. Safe to call more than once. */
  close(): void;
}

function identifier(value: string): string {
  if (!value || value.includes('\0'))
    throw new Error('Invalid SQLite identifier');

  return `"${value.replaceAll('"', '""')}"`;
}

/** Read one SQLite resource through Relate's source connector contract. */
export function sqlite(options: SqliteOptions): SqliteConnection {
  const identityTable = identifier(options.identity.table);
  const identityColumn = identifier(options.identity.column);
  const db = new DatabaseSync(options.path, {
    readOnly: true,
    enableDoubleQuotedStringLiterals: false,
    allowExtension: false,
    timeout: 0,
  });
  let closed = false;

  function account(): string {
    const rows = db
      .prepare(
        `SELECT ${identityColumn} AS account FROM ${identityTable} LIMIT 2`,
      )
      .all();
    const id = rows[0]?.account;

    if (rows.length !== 1 || typeof id !== 'string' || !id.trim()) {
      // Invalid identity must not permit fallback to data from an old account.
      throw new SourceAccessDenied();
    }

    return id;
  }

  function read<T>(signal: AbortSignal, operation: () => T): T {
    signal.throwIfAborted();

    if (closed) throw new Error('SQLite connector is closed');

    try {
      db.exec('BEGIN');

      try {
        const result = operation();

        signal.throwIfAborted();

        return result;
      } finally {
        db.exec('ROLLBACK');
      }
    } catch (error) {
      // SQLite primary result codes: PERM (3), AUTH (23).
      const code = (error as { errcode?: number }).errcode;

      if (typeof code === 'number' && [3, 23].includes(code & 0xff))
        throw new SourceAccessDenied();

      throw error;
    }
  }

  return {
    table(name, { idColumn }) {
      const table = identifier(name);
      const key = identifier(idColumn);

      return {
        async identify({ signal }) {
          return read(signal, account);
        },
        async fetch(sourceRecordId, { signal }): Promise<SourceRecord> {
          return read(signal, () => {
            const providerAccountId = account();
            const rows = db
              .prepare(`SELECT * FROM ${table} WHERE ${key} = ? LIMIT 2`)
              .all(sourceRecordId);

            if (rows.length > 1)
              throw new Error('SQLite source key is not unique');

            const row = rows[0];

            if (!row) return { providerAccountId, state: 'deleted' };

            if (
              typeof row[idColumn] !== 'string' ||
              row[idColumn] !== sourceRecordId
            )
              throw new Error('SQLite source key must be an exact TEXT ID');

            const record: Record<string, string | number | null> =
              Object.create(null);

            for (const [name, value] of Object.entries(row)) {
              if (
                value === null ||
                typeof value === 'string' ||
                (typeof value === 'number' && Number.isFinite(value))
              )
                record[name] = value;
              else
                throw new Error(`SQLite column ${name} is not a JSON scalar`);
            }

            return {
              providerAccountId,
              state: 'present',
              record: { ...record },
            };
          });
        },
      };
    },
    close() {
      if (closed) return;

      db.close();
      closed = true;
    },
  };
}
