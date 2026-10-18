import { fork } from 'node:child_process';
import pg from 'pg';
import { generate } from './generate.js';
import { SpikeError } from './contracts.js';
import type { Backend, Row } from './contracts.js';

/** A process, not a thread: Worker.terminate() cannot interrupt DatabaseSync
 * while native SQLite is running on the tested Node build. This probes bounded
 * cancellation; process pooling and startup amortization are not implemented. */
export function sqliteBackend(path: string): Backend {
  return {
    dialect: 'sqlite',
    plan: (association, candidates, expressions) =>
      generate('sqlite', association, candidates, expressions),
    async execute(statement, { signal, timeoutMs }) {
      signal.throwIfAborted();
      const worker = fork(
        new URL('./sqlite-child.mjs', import.meta.url),
        [path],
        {
          serialization: 'advanced',
          execArgv: [],
          stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
        },
      );
      const exited = new Promise<void>((resolve) =>
        worker.once('exit', () => resolve()),
      );
      let timer: ReturnType<typeof setTimeout> | undefined;
      let startup: ReturnType<typeof setTimeout> | undefined;
      let abort: () => void = () => {};

      try {
        return await new Promise<Row[]>((resolve, reject) => {
          abort = () => reject(signal.reason);
          signal.addEventListener('abort', abort, { once: true });
          worker.on('error', reject);
          worker.on('exit', () =>
            reject(new SpikeError('execution-failed', 'process-exit')),
          );
          startup = setTimeout(
            () => reject(new SpikeError('execution-failed', 'process-startup')),
            2000,
          );
          worker.on('message', (message: any) => {
            if (message.ready) {
              clearTimeout(startup);
              timer = setTimeout(
                () =>
                  reject(
                    new SpikeError('execution-failed', 'statement-timeout'),
                  ),
                timeoutMs,
              );
              worker.send(statement);
            } else if (message.error)
              reject(new SpikeError('execution-failed', 'sqlite-statement'));
            else resolve(message.rows);
          });
        });
      } finally {
        clearTimeout(startup);
        clearTimeout(timer);
        signal.removeEventListener('abort', abort);
        worker.kill('SIGKILL');
        await exited;
      }
    },
  };
}

/** Separate physical client per statement, not a production connection pool.
 * Cancellation uses a control connection plus destruction of the owned client;
 * destroying it prevents a late cancellation from affecting a subsequent read. */
export function postgresBackend(connectionString: string): Backend {
  return {
    dialect: 'postgres',
    plan: (association, candidates, expressions) =>
      generate('postgres', association, candidates, expressions),
    async execute(statement, { signal, timeoutMs }) {
      signal.throwIfAborted();
      const client = new pg.Client({
        connectionString,
        connectionTimeoutMillis: 2000,
      });
      let cancel: Promise<unknown> | undefined;
      let abort: () => void = () => {};

      try {
        await client.connect();
        signal.throwIfAborted();
        const pid = (await client.query('SELECT pg_backend_pid() AS pid'))
          .rows[0].pid;

        abort = () => {
          const control = new pg.Client({
            connectionString,
            connectionTimeoutMillis: 500,
          });

          cancel = (async () => {
            try {
              await control.connect();
              await control.query('SELECT pg_cancel_backend($1)', [pid]);
            } catch {
              /* Destroying the statement client is the fallback. */
            } finally {
              await control.end();
              await client.end();
            }
          })();
        };
        signal.addEventListener('abort', abort, { once: true });
        signal.throwIfAborted();
        await client.query('BEGIN READ ONLY');
        await client.query("SELECT set_config('statement_timeout', $1, true)", [
          String(timeoutMs),
        ]);
        signal.throwIfAborted();
        const result = await client.query(statement.text, statement.values);

        signal.throwIfAborted();
        await client.query('COMMIT');

        return result.rows;
      } catch (error) {
        if (signal.aborted) throw signal.reason;

        throw error;
      } finally {
        signal.removeEventListener('abort', abort);
        await cancel;
        await client.end();
      }
    },
  };
}
