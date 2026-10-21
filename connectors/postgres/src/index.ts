import type {
  AnalyticalConnector,
  AnalyticalResource,
  DatasetResource,
  PreparedPlan,
} from 'relate/connectors';
import { DatasetExecutionError } from 'relate/connectors';
import { identifier } from './identifiers.js';
import { render, parameterBudget } from './plan.js';
import type { SelectedDataset, PostgresPlan } from './plan.js';
import { createRunner } from './runner.js';
import { describe } from './schema.js';
import { decode } from './results.js';

export interface PostgresOptions {
  readonly connectionId: string;
  readonly url: string;
  /** Bounded connection and transaction setup. Default 5 seconds. */
  readonly analyticalStartupTimeoutMs?: number;
  /** Bounded independent cancellation control connection. Default 2 seconds. */
  readonly cancellationTimeoutMs?: number;
}

export interface PostgresConnection {
  readonly connectionId: string;
  readonly analytics: AnalyticalConnector;
  table(
    name: string,
    options?: { readonly schema?: string },
  ): AnalyticalResource;
  /** Retire statements and wait for primary/control client cleanup. */
  close(): Promise<void>;
}

function milliseconds(value: number | undefined, fallback: number): number {
  const result = value ?? fallback;

  if (!Number.isSafeInteger(result) || result < 1 || result > 60_000)
    throw new Error('PostgreSQL lifecycle timeout must be between 1 and 60000');

  return result;
}

/** Dataset capability only; Relate observation persistence lives in @relate/postgres. */
export function postgres(options: PostgresOptions): PostgresConnection {
  if (typeof options.connectionId !== 'string' || !options.connectionId.trim())
    throw new Error('PostgreSQL connectionId must be nonempty');

  if (
    typeof options.url !== 'string' ||
    !/^postgres(?:ql)?:\/\//.test(options.url)
  )
    throw new Error('PostgreSQL url must be a PostgreSQL connection URL');

  const runner = createRunner({
    url: options.url,
    startupTimeoutMs: milliseconds(options.analyticalStartupTimeoutMs, 5000),
    cancelTimeoutMs: milliseconds(options.cancellationTimeoutMs, 2000),
  });
  const resources = new WeakMap<DatasetResource, SelectedDataset>();
  const plans = new WeakMap<PreparedPlan, PostgresPlan>();
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
    limits: Object.freeze({ maxParameters: 65535 }),
    describe(resource, input) {
      const resourceSelection = selected(resource);

      return runner.run((client) => describe(client, resourceSelection), {
        ...input,
        timeoutMs: 5000,
      });
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
    execute(handle, input) {
      open();
      const plan = plans.get(handle);

      if (!plan) throw new Error('Foreign analytical plan');

      if (
        !Number.isSafeInteger(input.timeoutMs) ||
        input.timeoutMs < 1 ||
        input.timeoutMs > 2147483647
      )
        throw new Error('Invalid analytical statement timeout');

      return runner.run(
        async (client, readAt) =>
          decode(plan, await client.query(plan.sql, plan.values), readAt),
        input,
      );
    },
  });
  const connection: PostgresConnection = Object.freeze<PostgresConnection>({
    connectionId: options.connectionId,
    analytics,
    table(name, input = {}) {
      open();
      const schema = input.schema ?? 'public';

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
