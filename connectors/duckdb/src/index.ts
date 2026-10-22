import type {
  AnalyticalConnector,
  AnalyticalResource,
  DatasetResource,
  PreparedPlan,
} from 'relate/connectors';
import { DatasetExecutionError } from 'relate/connectors';
import { identifier } from './identifiers.js';
import { render, parameterBudget } from './plan.js';
import type { SelectedDataset, DuckDBPlan } from './plan.js';
import { createProcessRunner } from './process.js';
import type { DuckDBDiagnostic } from './process.js';

export type { DuckDBDiagnostic } from './process.js';

import type { PhysicalSchema, DatasetExecution } from 'relate/connectors';
import { resolve } from 'node:path';

export interface DuckDBOptions {
  readonly connectionId: string;
  readonly path: string;
  /** Host-only driver diagnostics; may include private physical names and values. */
  readonly onDiagnostic?: (diagnostic: DuckDBDiagnostic) => void;
  /** Bounded native module loading and database setup. Default 5 seconds. */
  readonly analyticalStartupTimeoutMs?: number;
}

export interface DuckDBConnection {
  readonly connectionId: string;
  readonly system: 'duckdb';
  readonly analytics: AnalyticalConnector;
  table(
    name: string,
    options?: { readonly schema?: string },
  ): AnalyticalResource;
  /** Retire statements and wait for child process cleanup. */
  close(): Promise<void>;
}

function milliseconds(value: number | undefined, fallback: number): number {
  const result = value ?? fallback;

  if (!Number.isSafeInteger(result) || result < 1 || result > 60_000)
    throw new Error('DuckDB lifecycle timeout must be between 1 and 60000');

  return result;
}

/** Read-only analytical datasets from an existing DuckDB file. */
export function duckdb(options: DuckDBOptions): DuckDBConnection {
  if (typeof options.connectionId !== 'string' || !options.connectionId.trim())
    throw new Error('DuckDB connectionId must be nonempty');

  if (
    typeof options.path !== 'string' ||
    !options.path.trim() ||
    options.path === ':memory:'
  )
    throw new Error('DuckDB analytics requires an existing database file');

  const runner = createProcessRunner({
    path: resolve(options.path),
    ...(options.onDiagnostic ? { onDiagnostic: options.onDiagnostic } : {}),
    startupTimeoutMs: milliseconds(options.analyticalStartupTimeoutMs, 5000),
  });
  const resources = new WeakMap<DatasetResource, SelectedDataset>();
  const plans = new WeakMap<PreparedPlan, DuckDBPlan>();
  let closed = false;
  const open = () => {
    if (closed)
      throw new DatasetExecutionError('execution-failed', { retryable: false });
  };
  const selected = (handle: DatasetResource) => {
    open();
    const resource = resources.get(handle);

    if (!resource) throw new Error('Foreign analytical resource');

    return resource;
  };
  const analytics = Object.freeze<AnalyticalConnector>({
    limits: Object.freeze({ maxParameters: 65535, maxConcurrentStatements: 4 }),
    async describe(resource, input) {
      const resourceSelection = selected(resource);

      return (await runner.run(
        { kind: 'describe', resource: resourceSelection },
        {
          ...input,
          timeoutMs: 5000,
        },
      )) as PhysicalSchema;
    },
    parameterBudget(query) {
      selected(query.resource);

      return parameterBudget(query);
    },
    plan(query) {
      if (!query.slots.length)
        throw new Error('Analytical plans require at least one slot');

      const generated = render(query, selected(query.resource), query.slots);

      if (generated.values.length > 65535)
        throw new Error('Analytical parameter limit exceeded');

      const handle = Object.freeze({}) as PreparedPlan;

      plans.set(handle, generated);

      return handle;
    },
    async execute(handle, input) {
      open();
      const plan = plans.get(handle);

      if (!plan) throw new Error('Foreign analytical plan');

      if (
        !Number.isSafeInteger(input.timeoutMs) ||
        input.timeoutMs < 1 ||
        input.timeoutMs > 2147483647
      )
        throw new Error('Invalid analytical statement timeout');

      return (await runner.run(
        { kind: 'execute', plan },
        input,
      )) as DatasetExecution;
    },
  });
  const connection: DuckDBConnection = Object.freeze<DuckDBConnection>({
    connectionId: options.connectionId,
    system: 'duckdb',
    analytics,
    table(name, input = {}) {
      open();
      const schema = input.schema ?? 'main';

      identifier(name);
      identifier(schema);

      return Object.freeze<AnalyticalResource>({
        connection,
        resourceId: JSON.stringify([schema, name]),
        bindDataset(selection) {
          open();
          const columns = Object.freeze({ ...selection.columns });

          for (const column of Object.values(columns)) identifier(column);

          const handle = Object.freeze({}) as DatasetResource;

          resources.set(
            handle,
            Object.freeze({ table: name, schema, columns }),
          );

          return handle;
        },
      });
    },
    close() {
      closed = true;

      return runner.close();
    },
  });

  return connection;
}
