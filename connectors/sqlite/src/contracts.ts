import type { SourceRecord } from 'relate/connectors';

export interface SqliteOptions {
  /** Existing database file. The connector never creates or writes it. */
  readonly path: string;
  /** Singleton table containing the database's stable, nonempty TEXT account ID. */
  readonly identity: { readonly table: string; readonly column: string };
  /** Time to wait for a writer lock in the worker. Default: 150 ms. */
  readonly busyTimeoutMs?: number;
}

export interface SqliteTableOptions {
  /** TEXT key matching the source idField. Included in every returned record. */
  readonly idColumn: string;
  /** Other columns to expose to Relate. Unlisted columns are never read or retained. */
  readonly columns: readonly string[];
}

export type Operation =
  | { operation: 'identify' }
  | {
      operation: 'fetch';
      table: string;
      options: SqliteTableOptions;
      recordId: string;
    };

export type Request = Operation & { id: number };

/** Fully resolved settings passed by the connection owner to its worker. */
export type WorkerSettings = SqliteOptions & { readonly busyTimeoutMs: number };

export type Response =
  | { id: number; ok: true; result: string | SourceRecord }
  | {
      id: number;
      ok: false;
      error: {
        message: string;
        denied: boolean;
        code?: string;
        errcode?: number;
      };
    };

export function identifier(value: string): string {
  if (!value || value.includes('\0'))
    throw new Error('Invalid SQLite identifier');

  return `"${value.replaceAll('"', '""')}"`;
}
