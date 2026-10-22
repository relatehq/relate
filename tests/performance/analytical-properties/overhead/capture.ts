import assert from 'node:assert/strict';
import { AsyncLocalStorage } from 'node:async_hooks';
import { ChildProcess } from 'node:child_process';
import pg from 'pg';
import type {
  AnalyticalResource,
  AuthorizedDatasetQuery,
  DatasetExecution,
  PreparedPlan,
} from 'relate/connectors';

export interface Statement {
  plan: PreparedPlan;
  query: AuthorizedDatasetQuery;
  sql?: string;
  parameters?: unknown[];
  rawRows?: unknown[][];
  rows?: DatasetExecution['rows'];
}
export interface Interval {
  startMs: number;
  endMs: number;
}

/** Wall time covered by at least one connector call, not summed overlapping work. */
export function unionDuration(intervals: Interval[]): number {
  let end = -Infinity,
    total = 0;

  for (const span of [...intervals].sort((a, b) => a.startMs - b.startMs)) {
    assert(span.endMs >= span.startMs);
    total += Math.max(0, span.endMs - Math.max(end, span.startMs));
    end = Math.max(end, span.endMs);
  }

  return total;
}

/** Capture exact driver/IPC input only during untimed preparation; no product exports. */
export function observeResource(original: AnalyticalResource) {
  const analytics = original.connection.analytics;
  const context = new AsyncLocalStorage<Statement>();
  let recording: Statement[] | undefined;
  let intervals: Interval[] | undefined;
  const plans = new WeakMap<PreparedPlan, Statement>();
  const resource: AnalyticalResource = {
    ...original,
    connection: {
      ...original.connection,
      analytics: {
        ...analytics,
        plan(query) {
          const plan = analytics.plan(query);

          if (recording) {
            const statement = { plan, query };
            plans.set(plan, statement);
            recording.push(statement);
          }

          return plan;
        },
        async execute(plan, options) {
          const statement = recording ? plans.get(plan) : undefined;
          const spans = intervals;
          const startMs = performance.now();

          try {
            const result = await (statement
              ? context.run(statement, () => analytics.execute(plan, options))
              : analytics.execute(plan, options));

            if (statement) statement.rows = result.rows;

            return result;
          } finally {
            spans?.push({ startMs, endMs: performance.now() });
          }
        },
      },
    },
  };

  return {
    resource,
    intervals(value: Interval[] | undefined) {
      intervals = value;
    },
    async capture<T>(task: () => Promise<T>) {
      assert(!recording, 'Capture must not nest');
      const statements: Statement[] = [];
      const query = pg.Client.prototype.query;
      const send = ChildProcess.prototype.send;
      recording = statements;
      pg.Client.prototype.query = function (this: pg.Client, ...args: unknown[]) {
        const statement = context.getStore();
        const config = args[0] as
          { text?: string; values?: unknown[] } | undefined;
        const result = Reflect.apply(query, this, args);

        if (statement && config?.text?.startsWith('WITH keys(')) {
          assert.equal(statement.sql, undefined, 'One SQL statement per plan');
          statement.sql = config.text;
          statement.parameters = structuredClone(config.values ?? []);

          return (result as Promise<pg.QueryResult>).then((value) => {
            statement.rawRows = structuredClone(value.rows);
            return value;
          });
        }

        return result;
      } as typeof query;
      ChildProcess.prototype.send = function (this: ChildProcess, ...args: unknown[]) {
        const statement = context.getStore();
        const message = args[0] as {
          kind?: string;
          plan?: { sql: string; values: unknown[] };
        };

        if (statement && message?.kind === 'execute' && message.plan) {
          assert.equal(statement.sql, undefined, 'One IPC statement per plan');
          statement.sql = message.plan.sql;
          statement.parameters = structuredClone(message.plan.values);
        }

        return Reflect.apply(send, this, args);
      } as typeof send;

      try {
        const result = await task();

        for (const statement of statements) {
          assert(statement.sql && statement.parameters && statement.rows);
          statement.rawRows ??= statement.rows.map((row) => [
            row.slot,
            ...row.values,
          ]);
        }

        assert(statements.length > 0, 'No generated statements captured');
        return { result, statements };
      } finally {
        pg.Client.prototype.query = query;
        ChildProcess.prototype.send = send;
        recording = undefined;
      }
    },
  };
}

/** Same work-conserving bounded scheduling as the host's statement workers. */
export async function concurrentMap<T, R>(
  items: readonly T[],
  concurrency: number,
  task: (item: T, index: number, worker: number) => Promise<R>,
): Promise<R[]> {
  assert(Number.isInteger(concurrency) && concurrency > 0);
  let next = 0;
  const results: R[] = [];
  const failures: unknown[] = [];
  await Promise.all(
    Array.from(
      { length: Math.min(concurrency, items.length) },
      async (_, worker) => {
        try {
          while (next < items.length) {
            const index = next++;
            results[index] = await task(items[index]!, index, worker);
          }
        } catch (error) {
          failures.push(error);
        }
      },
    ),
  );
  if (failures.length) throw failures[0];
  return results;
}
