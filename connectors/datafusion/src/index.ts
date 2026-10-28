import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import type {
  AnalyticalConnector,
  AnalyticalResource,
  DatasetResource,
  PreparedPlan,
  PhysicalSchema,
  DatasetExecution,
} from 'relate/connectors';
import { DatasetExecutionError } from 'relate/connectors';
import { quoteSqlIdentifier } from 'relate/analytics';
import { createRunner } from './process.js';
import type { DataFusionDiagnostic } from './process.js';
import { parameterBudget, render } from './plan.js';
import type { DataFusionPlan } from './plan.js';

export type { DataFusionDiagnostic } from './process.js';

export interface S3Options {
  readonly bucket: string;
  readonly region: string;
  readonly endpoint?: string;
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  readonly sessionToken?: string;
  /** Explicit opt-in for a local S3 emulator's HTTP endpoint. */
  readonly allowHttp?: boolean;
}

export type DataFusionSource =
  | { readonly kind: 'parquet'; readonly url: string; readonly s3?: S3Options }
  | {
      readonly kind: 'custom';
      readonly provider: string;
      readonly options: Readonly<Record<string, unknown>>;
    };

export interface DataFusionOptions {
  readonly connectionId: string;
  /** Host-built executable, including custom Rust provider registrations. */
  readonly enginePath?: string;
  readonly startupTimeoutMs?: number;
  /** Host-only details; may include private paths or provider errors. */
  readonly onDiagnostic?: (diagnostic: DataFusionDiagnostic) => void;
}

export interface DataFusionConnection {
  readonly connectionId: string;
  readonly system: 'datafusion';
  readonly analytics: AnalyticalConnector;
  parquet(
    url: string,
    options?: { readonly s3?: S3Options },
  ): AnalyticalResource;
  custom(
    provider: string,
    options: Readonly<Record<string, unknown>>,
  ): AnalyticalResource;
  close(): Promise<void>;
}

type Selection = {
  source: DataFusionSource;
  columns: Readonly<Record<string, string>>;
};

function milliseconds(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > 2147483647)
    throw new Error('Invalid DataFusion timeout');

  return value;
}

function invalid(): never {
  throw new DatasetExecutionError('invalid-result', { retryable: false });
}

function decode(
  raw: unknown,
  plan: DataFusionPlan,
  readAt: string,
): DatasetExecution {
  if (
    !raw ||
    typeof raw !== 'object' ||
    !('rows' in raw) ||
    !Array.isArray(raw.rows) ||
    raw.rows.length !== plan.slots
  )
    return invalid();

  const rows = raw.rows.map((row: unknown, slot: number) => {
    if (
      !Array.isArray(row) ||
      row.length !== 1 + 2 * plan.results.length ||
      row[0] !== slot
    )
      return invalid();

    const values = row
      .slice(1, 1 + plan.results.length)
      .map((value: unknown, i: number) => {
        const type = plan.results[i]!.type;

        if (value === null) return null;

        if (type === 'int64') {
          if (typeof value !== 'string' || !/^-?\d+$/.test(value))
            return invalid();

          return BigInt(value);
        }

        if (
          type === 'float64' &&
          typeof value === 'object' &&
          value &&
          'nonFinite' in value
        )
          return NaN;

        if (
          (['string', 'timestamp', 'date'].includes(type) &&
            typeof value === 'string') ||
          (['int32', 'float64'].includes(type) && typeof value === 'number') ||
          (type === 'boolean' && typeof value === 'boolean')
        )
          return value;

        return invalid();
      });
    const checks = row.slice(1 + plan.results.length).map((value: unknown) => {
      if (value !== 0 && value !== 1 && value !== '0' && value !== '1')
        return invalid();

      return { arithmeticFailed: value === 1 || value === '1' };
    });

    return { slot, values, checks };
  });

  return { rows, readAt };
}

export function datafusion(options: DataFusionOptions): DataFusionConnection {
  if (typeof options.connectionId !== 'string' || !options.connectionId.trim())
    throw new Error('DataFusion connectionId must be nonempty');

  const runner = createRunner({
    executable:
      options.enginePath ??
      fileURLToPath(
        new URL('../engine/target/debug/relate-datafusion', import.meta.url),
      ),
    startupTimeoutMs: milliseconds(options.startupTimeoutMs ?? 10000),
    ...(options.onDiagnostic ? { onDiagnostic: options.onDiagnostic } : {}),
  });
  const resources = new WeakMap<DatasetResource, Selection>();
  const plans = new WeakMap<
    PreparedPlan,
    { selection: Selection; plan: DataFusionPlan }
  >();
  let closed = false;
  const open = () => {
    if (closed)
      throw new DatasetExecutionError('execution-failed', { retryable: false });
  };
  const selected = (handle: DatasetResource) => {
    open();
    const value = resources.get(handle);

    if (!value) throw new Error('Foreign analytical resource');

    return value;
  };
  const analytics: AnalyticalConnector = Object.freeze<AnalyticalConnector>({
    limits: Object.freeze({ maxParameters: 65535, maxConcurrentStatements: 4 }),
    async describe(resource, input) {
      const selection = selected(resource);
      const { value: result } = await runner.run(
        { ...selection, operation: { kind: 'describe' } },
        { ...input, timeoutMs: 5000 },
      );

      if (
        !result ||
        typeof result !== 'object' ||
        !('columns' in result) ||
        !result.columns ||
        typeof result.columns !== 'object' ||
        Array.isArray(result.columns)
      )
        return invalid();

      return result as PhysicalSchema;
    },
    parameterBudget(query) {
      selected(query.resource);

      return parameterBudget(query);
    },
    plan(query) {
      const selection = selected(query.resource);

      if (!query.slots.length)
        throw new Error('Analytical plans require at least one slot');

      const plan = render(query, {
        table: 'dataset',
        columns: selection.columns,
      });

      if (plan.values.length > 65535)
        throw new Error('Analytical parameter limit exceeded');

      const handle = Object.freeze({}) as PreparedPlan;

      plans.set(handle, { selection, plan });

      return handle;
    },
    async execute(handle, input) {
      open();
      const owned = plans.get(handle);

      if (!owned) throw new Error('Foreign analytical plan');

      milliseconds(input.timeoutMs);
      const { value: raw, readAt } = await runner.run(
        {
          ...owned.selection,
          operation: {
            kind: 'execute',
            sql: owned.plan.sql,
            values: owned.plan.values,
          },
        },
        input,
      );

      return decode(raw, owned.plan, readAt);
    },
  });
  const resource = (source: DataFusionSource): AnalyticalResource => {
    open();
    // Detach host configuration from later mutation; credentials never enter resourceId.
    const owned = JSON.parse(JSON.stringify(source)) as DataFusionSource;

    return Object.freeze({
      connection,
      resourceId:
        source.kind === 'parquet' ? source.url : `custom:${source.provider}`,
      bindDataset(selection: { columns: Readonly<Record<string, string>> }) {
        open();
        const columns = Object.freeze({ ...selection.columns });

        for (const column of Object.values(columns)) quoteSqlIdentifier(column);

        const handle = Object.freeze({}) as DatasetResource;

        resources.set(handle, { source: owned, columns });

        return handle;
      },
    });
  };
  const connection: DataFusionConnection = Object.freeze<DataFusionConnection>({
    connectionId: options.connectionId,
    system: 'datafusion',
    analytics,
    parquet(url, input = {}) {
      if (typeof url !== 'string' || !url.trim())
        throw new Error('Parquet location must be nonempty');

      return resource({
        kind: 'parquet',
        url: url.includes('://') ? url : resolve(url),
        ...(input.s3 ? { s3: input.s3 } : {}),
      });
    },
    custom(provider, input) {
      if (typeof provider !== 'string' || !provider.trim())
        throw new Error('Custom provider name must be nonempty');

      return resource({ kind: 'custom', provider, options: input });
    },
    close() {
      closed = true;

      return runner.close();
    },
  });

  return connection;
}
