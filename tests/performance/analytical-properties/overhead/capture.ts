import assert from 'node:assert/strict';
import { isDeepStrictEqual } from 'node:util';
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

async function watchSpawns<T>(
  visit: (child: ChildProcess) => void,
  task: () => Promise<T>,
) {
  const emit = ChildProcess.prototype.emit;
  const owned = Object.hasOwn(ChildProcess.prototype, 'emit');

  ChildProcess.prototype.emit = function (
    this: ChildProcess,
    event: string | symbol,
    ...args: unknown[]
  ) {
    if (event === 'spawn') visit(this);

    return Reflect.apply(emit, this, [event, ...args]);
  };

  try {
    return await task();
  } finally {
    if (owned) ChildProcess.prototype.emit = emit;
    else Reflect.deleteProperty(ChildProcess.prototype, 'emit');
  }
}

/** Capture exact driver/IPC input only during untimed preparation; no product exports. */
export function observeResource(original: AnalyticalResource) {
  const analytics = original.connection.analytics;
  const context = new AsyncLocalStorage<Statement>();
  const children = new Set<ChildProcess>();
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
    initialize<T>(task: () => Promise<T>) {
      return watchSpawns((child) => children.add(child), task);
    },
    intervals(value: Interval[] | undefined) {
      intervals = value;
    },
    async capture<T>(task: () => Promise<T>) {
      assert(!recording, 'Capture must not nest');
      const statements: Statement[] = [];
      const query = pg.Client.prototype.query;
      const sends = new Map<ChildProcess, ChildProcess['send']>();

      recording = statements;
      pg.Client.prototype.query = function (
        this: pg.Client,
        ...args: unknown[]
      ) {
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
      const attach = (child: ChildProcess) => {
        children.add(child);

        if (sends.has(child)) return;

        const send = child.send;

        sends.set(child, send);
        child.send = function (this: ChildProcess, ...args: unknown[]) {
          const message = args[0] as {
            kind?: string;
            plan?: { sql: string; values: unknown[]; slots: number };
          };

          if (message?.kind === 'execute' && message.plan) {
            // A pooled child's ready callback may originate in an earlier request's
            // async context. Match the complete slot parameter prefix instead.
            const matches = statements.filter((s) => {
              const prefix = s.query.slots.flatMap((slot, index) => [
                index,
                ...slot.values.map((value) => value.value),
                ...slot.valid,
              ]);

              return (
                !s.sql &&
                s.query.slots.length === message.plan!.slots &&
                isDeepStrictEqual(
                  prefix,
                  message.plan!.values.slice(0, prefix.length),
                )
              );
            });

            assert.equal(
              matches.length,
              1,
              'IPC plan must match exactly one captured slot set',
            );
            const statement = matches[0]!;

            statement.sql = message.plan.sql;
            statement.parameters = structuredClone(message.plan.values);
          }

          return Reflect.apply(send, this, args);
        } as typeof send;
      };

      for (const child of children) attach(child);

      try {
        const result = await watchSpawns(attach, task);

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

        for (const [child, send] of sends) child.send = send;

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
