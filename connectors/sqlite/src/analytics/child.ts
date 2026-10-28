import { canonicalDate, canonicalTimestamp } from 'relate/analytics';
import { Worker } from 'node:worker_threads';
import { DatabaseSync } from 'node:sqlite';
import type { SQLOutputValue } from 'node:sqlite';
import type {
  PhysicalColumn,
  PhysicalSchema,
  DatasetExecution,
} from 'relate/connectors';
import { identifier } from '../contracts.js';
import type { ChildRequest, ChildResponse } from './messages.js';
import type { SelectedDataset, SqlitePlan } from './plan.js';

let database: DatabaseSync | undefined;
let watchdog: Worker | undefined;

class InvalidResult extends Error {}

function inspect(resource: SelectedDataset): PhysicalSchema {
  const rows = database!
    .prepare(`PRAGMA table_info(${identifier(resource.table)})`)
    .all();

  if (!rows.length) throw new Error('Missing table');

  const columns: Record<string, PhysicalColumn> = {};

  for (const [declared, physical] of Object.entries(resource.columns)) {
    const row = rows.find(
      (row) =>
        typeof row.name === 'string' &&
        row.name.toLowerCase() === physical.toLowerCase(),
    );

    if (!row) continue;

    const databaseType = String(row.type);
    const type = databaseType.toUpperCase();
    const supportedTypes: PhysicalColumn['supportedTypes'] = /INT|BOOL/.test(
      type,
    )
      ? [{ type: 'boolean' }, { type: 'int32' }, { type: 'int64' }]
      : /CHAR|CLOB|TEXT|DATE|TIMESTAMP/.test(type)
        ? [
            { type: 'string' },
            { type: 'timestamp', precision: 3 },
            { type: 'timestamp', precision: 6 },
            { type: 'date' },
          ]
        : /BLOB/.test(type) || !type
          ? []
          : /REAL|FLOA|DOUB/.test(type)
            ? [{ type: 'float64' }]
            : [];

    Object.defineProperty(columns, declared, {
      enumerable: true,
      value: { supportedTypes, nullable: row.notnull !== 1, databaseType },
    });
  }

  return { columns };
}

function execute(plan: SqlitePlan): DatasetExecution {
  const readAt = new Date().toISOString();
  const statement = database!.prepare(plan.sql);

  statement.setReadBigInts(true);
  // Minimum supported Node versions treat ?NNN as named parameters; passing
  // them positionally fails with "column index out of range" on those versions.
  const raw = statement.all(
    Object.fromEntries(plan.values.map((value, i) => [`?${i + 1}`, value])),
  );

  if (raw.length !== plan.slots) throw new InvalidResult();

  const rows = raw.map((row, slot) => {
    if (
      row.slot !== BigInt(slot) ||
      Object.keys(row).length !== plan.results.length * 2 + 1
    )
      throw new InvalidResult();

    const values = plan.results.map((result, i) => {
      const value: SQLOutputValue | undefined = row[`v${i}`];

      if (
        value !== null &&
        !['number', 'bigint', 'boolean', 'string'].includes(typeof value)
      )
        throw new InvalidResult();

      if (result.type === 'boolean' && (value === 0n || value === 1n))
        return value === 1n;

      if (
        result.type === 'int32' &&
        typeof value === 'bigint' &&
        value >= -2147483648n &&
        value <= 2147483647n
      )
        return Number(value);

      if (result.type === 'timestamp' && typeof value === 'string') {
        try {
          return canonicalTimestamp(value, result.precision);
        } catch {
          /* Preserve invalid scalar for alias withdrawal. */
        }
      }

      return value as string | number | bigint | boolean | null;
    });

    const checks = plan.results.map((_, i) => {
      const check: SQLOutputValue | undefined = row[`c${i}`];

      if (check !== 0n && check !== 1n) throw new InvalidResult();

      return { arithmeticFailed: check === 1n };
    });

    return { slot, values, checks };
  });

  return { rows, readAt };
}

async function finish(message: ChildResponse) {
  try {
    database?.close();
  } catch {
    message = { kind: 'failure', code: 'execution-failed', retryable: false };
  }

  database = undefined;
  await watchdog?.terminate();
  watchdog = undefined;
  process.send?.(message);
}

process.on('disconnect', () => {
  process.exit(0);
});

process.on('message', (request: ChildRequest) => {
  try {
    if (request.kind === 'open') {
      watchdog = new Worker(new URL('./watchdog.js', import.meta.url), {
        workerData: { parent: process.ppid, lifetimeMs: request.lifetimeMs },
      });
      watchdog.unref();
      database = new DatabaseSync(request.path, {
        readOnly: true,
        enableDoubleQuotedStringLiterals: false,
        allowExtension: false,
        timeout: request.busyTimeoutMs,
      });
      // Canonical milliseconds and microseconds denote the same instant at equality.
      // Noncanonical TEXT is otherwise trusted, matching the physical-schema contract.
      database.function('__relate_instant', { deterministic: true }, (value) =>
        typeof value === 'string' &&
        /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value)
          ? `${value.slice(0, -1)}000Z`
          : value,
      );
      // A TEXT check cannot prove dates, so every participating value is checked.
      // The thrown error is sanitized and reported as execution-failed.
      database.function('__relate_date', { deterministic: true }, (value) =>
        value === null ? null : canonicalDate(value),
      );
      process.send?.({ kind: 'ready' } satisfies ChildResponse);
    } else {
      const value =
        request.kind === 'describe'
          ? inspect(request.resource)
          : execute(request.plan);

      void finish({ kind: 'result', value });
    }
  } catch (error) {
    const errcode = (error as { errcode?: number }).errcode;

    void finish({
      kind: 'failure',
      code:
        error instanceof InvalidResult ? 'invalid-result' : 'execution-failed',
      retryable:
        typeof errcode === 'number' &&
        ((errcode & 0xff) === 5 || (errcode & 0xff) === 6),
    });
  }
});
