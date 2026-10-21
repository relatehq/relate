import { DuckDBInstance } from '@duckdb/node-api';
import type { DuckDBConnection } from '@duckdb/node-api';
import type { DatasetExecution } from 'relate/connectors';
import type { ChildRequest, ChildResponse } from './messages.js';
import type { DuckDBPlan } from './plan.js';
import { describe } from './schema.js';

let database: DuckDBInstance | undefined;
let connection: DuckDBConnection | undefined;

class InvalidResult extends Error {}

async function execute(plan: DuckDBPlan): Promise<DatasetExecution> {
  const readAt = new Date().toISOString();
  const reader = await connection!.runAndReadAll(plan.sql, [...plan.values]);
  const raw = reader.getRows();

  if (raw.length !== plan.slots) throw new InvalidResult();

  const rows = raw.map((row, slot) => {
    if (row[0] !== slot || row.length !== plan.results.length + 1)
      throw new InvalidResult();

    const values = row.slice(1).map((value) => {
      if (
        value !== null &&
        !['string', 'number', 'bigint', 'boolean'].includes(typeof value)
      )
        throw new InvalidResult();

      return value as string | number | bigint | boolean | null;
    });

    return { slot, values };
  });

  return { rows, readAt };
}

function finish(message: ChildResponse) {
  try {
    connection?.closeSync();
    database?.closeSync();
  } catch {
    message = { kind: 'failure', code: 'execution-failed', retryable: false };
  }

  connection = undefined;
  database = undefined;
  process.send?.(message, () => {
    if (process.connected) process.disconnect();
  });
}

process.on('message', (request: ChildRequest) => {
  void (async () => {
    try {
      if (request.kind === 'open') {
        database = await DuckDBInstance.create(request.path, {
          access_mode: 'READ_ONLY',
          enable_external_access: 'false',
          autoload_known_extensions: 'false',
          autoinstall_known_extensions: 'false',
          threads: '1',
        });
        connection = await database.connect();
        process.send?.({ kind: 'ready' } satisfies ChildResponse);
      } else {
        const value =
          request.kind === 'describe'
            ? await describe(connection!, request.resource)
            : await execute(request.plan);

        finish({ kind: 'result', value });
      }
    } catch (error) {
      finish({
        kind: 'failure',
        code:
          error instanceof InvalidResult
            ? 'invalid-result'
            : 'execution-failed',
        retryable: false,
      });
    }
  })();
});
