import { Worker } from 'node:worker_threads';
import { resolve } from 'node:path';
import { SourceAccessDenied } from 'relate/connectors';
import type {
  SourceConnector,
  ApplicationSourceConnector,
  AnySourceConnector,
  SourceResult,
} from 'relate/connectors';
import { identifier } from './contracts.js';
import type {
  Operation,
  Request,
  WorkerSettings,
  Response,
  SqliteOptions,
  SqliteTableOptions,
} from './contracts.js';

export type { SqliteOptions, SqliteTableOptions } from './contracts.js';

export interface SqliteConnection<
  C extends AnySourceConnector = AnySourceConnector,
> {
  table(name: string, options: SqliteTableOptions): C;
  /** Reject outstanding reads and release the owned worker/connection. Idempotent. */
  close(): Promise<void>;
}

interface Pending {
  request: Request;
  resolve(value: string | SourceResult): void;
  reject(error: unknown): void;
  cleanup(): void;
}

/** One read-only SQLite connection, opened lazily in an owned worker. */
export function sqlite(
  options: SqliteOptions & { identity: NonNullable<SqliteOptions['identity']> },
): SqliteConnection<SourceConnector>;

export function sqlite(
  options: SqliteOptions & { identity?: undefined },
): SqliteConnection<ApplicationSourceConnector>;

export function sqlite(options: SqliteOptions): SqliteConnection;

export function sqlite(options: SqliteOptions): SqliteConnection {
  if (options.identity) {
    identifier(options.identity.table);
    identifier(options.identity.column);
  }

  const busyTimeoutMs = options.busyTimeoutMs ?? 150;

  if (
    !Number.isSafeInteger(busyTimeoutMs) ||
    busyTimeoutMs < 0 ||
    busyTimeoutMs > 60_000
  )
    throw new Error(
      'SQLite busyTimeoutMs must be an integer between 0 and 60000',
    );

  const settings: WorkerSettings = {
    path: resolve(options.path),
    ...(options.identity ? { identity: { ...options.identity } } : {}),
    busyTimeoutMs,
  };
  let worker: Worker | undefined;
  let stopping: Promise<void> | undefined;
  let closed = false;
  let nextId = 0;
  let active: Pending | undefined;
  const queue: Pending[] = [];

  function retire(): Promise<void> {
    const previous = worker;

    worker = undefined;

    if (!previous) return stopping ?? Promise.resolve();

    const completion = previous.terminate().then(() => {});

    stopping = completion;
    void completion.finally(() => {
      if (stopping === completion) stopping = undefined;

      pump();
    });

    return completion;
  }

  function fail(error: unknown): void {
    const pending = active;

    active = undefined;
    pending?.cleanup();
    pending?.reject(error);
    void retire();
  }

  function pump(): void {
    if (closed || active || stopping || queue.length === 0) return;

    active = queue.shift()!;

    try {
      if (!worker) {
        const current = new Worker(new URL('./worker.js', import.meta.url), {
          workerData: settings,
        });

        worker = current;
        current.on('message', (response: Response) => {
          if (worker !== current || response.id !== active?.request.id) return;

          const pending = active;

          active = undefined;
          pending.cleanup();
          current.unref();

          if (response.ok) pending.resolve(response.result);
          else {
            const error = response.error.denied
              ? new SourceAccessDenied()
              : new Error(response.error.message);

            error.message = response.error.message;
            Object.assign(
              error,
              response.error.code === undefined
                ? {}
                : { code: response.error.code },
              response.error.errcode === undefined
                ? {}
                : { errcode: response.error.errcode },
            );
            pending.reject(error);
          }

          pump();
        });
        current.on('error', (error) => {
          if (worker === current) fail(error);
        });
        current.on('exit', () => {
          if (worker === current) fail(new Error('SQLite worker exited'));
        });
      }

      worker.ref();
      worker.postMessage(active.request);
    } catch (error) {
      fail(error);
    }
  }

  function call(
    operation: Operation,
    signal: AbortSignal,
  ): Promise<string | SourceResult> {
    return new Promise((resolveCall, reject) => {
      signal.throwIfAborted();

      if (closed) throw new Error('SQLite connector is closed');

      const pending: Pending = {
        request: { ...operation, id: nextId++ },
        resolve: resolveCall,
        reject,
        cleanup: () => signal.removeEventListener('abort', abort),
      };

      function abort() {
        if (active === pending) fail(signal.reason);
        else {
          const index = queue.indexOf(pending);

          if (index !== -1) queue.splice(index, 1);

          pending.cleanup();
          pending.reject(signal.reason);
        }
      }

      signal.addEventListener('abort', abort, { once: true });
      queue.push(pending);
      pump();
    });
  }

  return {
    table(name, tableOptions) {
      identifier(name);
      identifier(tableOptions.idColumn);
      const columns = [...new Set(tableOptions.columns)];

      for (const column of columns) identifier(column);

      const resource = { idColumn: tableOptions.idColumn, columns };

      const fetch = async (
        recordId: string,
        { signal }: { signal: AbortSignal },
      ) =>
        (await call(
          { operation: 'fetch', table: name, options: resource, recordId },
          signal,
        )) as SourceResult;

      return settings.identity
        ? {
            identity: 'provider',
            async identify({ signal }: { signal: AbortSignal }) {
              return (await call({ operation: 'identify' }, signal)) as string;
            },
            fetch: fetch as SourceConnector['fetch'],
          }
        : {
            identity: 'application',
            fetch: fetch as ApplicationSourceConnector['fetch'],
          };
    },
    close() {
      closed = true;
      const error = new Error('SQLite connector is closed');

      active?.cleanup();
      active?.reject(error);
      active = undefined;

      for (const pending of queue.splice(0)) {
        pending.cleanup();
        pending.reject(error);
      }

      return retire();
    },
  };
}
