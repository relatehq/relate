import type {
  AnalyticalConnector,
  DatasetResource,
  DatasetSelection,
  PreparedPlan,
  PhysicalSchema,
  DatasetExecution,
} from 'relate/connectors';
import { DatasetExecutionError } from 'relate/connectors';
import { identifier } from '../contracts.js';
import { render } from './plan.js';
import type { SelectedDataset, SqlitePlan } from './plan.js';
import { createProcessRunner } from './process.js';

export function createAnalytics(settings: {
  path: string;
  busyTimeoutMs: number;
  startupTimeoutMs: number;
}) {
  const resources = new WeakMap<DatasetResource, SelectedDataset>();
  const plans = new WeakMap<PreparedPlan, SqlitePlan>();
  const runner = createProcessRunner(settings);
  let closed = false;
  const open = () => {
    if (closed)
      throw new DatasetExecutionError('execution-failed', { retryable: false });
  };
  const resource = (handle: DatasetResource) => {
    open();
    const selected = resources.get(handle);

    if (!selected) throw new Error('Foreign analytical resource');

    return selected;
  };
  const analytics = Object.freeze<AnalyticalConnector>({
    limits: Object.freeze({ maxParameters: 32766 }),
    async describe(handle, options) {
      return (await runner.run(
        { kind: 'describe', resource: resource(handle) },
        { ...options, timeoutMs: 5000 },
      )) as PhysicalSchema;
    },
    parameterBudget(query) {
      const fixed = render(query, resource(query.resource), []).values.length;

      return {
        fixed,
        perSlot: 1 + query.keys.length + query.aggregates.length,
      };
    },
    plan(query) {
      if (!query.slots.length)
        throw new Error('Analytical plans require at least one slot');

      const generated = render(query, resource(query.resource), query.slots);

      if (generated.values.length > 32766)
        throw new Error('Analytical parameter limit exceeded');

      const handle = Object.freeze({}) as PreparedPlan;

      plans.set(handle, generated);

      return handle;
    },
    async execute(handle, options) {
      open();
      const plan = plans.get(handle);

      if (!plan) throw new Error('Foreign analytical plan');

      if (
        !Number.isSafeInteger(options.timeoutMs) ||
        options.timeoutMs < 1 ||
        options.timeoutMs > 2147483647
      )
        throw new Error('Invalid analytical statement timeout');

      return (await runner.run(
        { kind: 'execute', plan },
        options,
      )) as DatasetExecution;
    },
  });

  return {
    analytics,
    bindDataset(table: string, selection: DatasetSelection): DatasetResource {
      open();
      identifier(table);
      const columns = Object.freeze({ ...selection.columns });

      for (const name of Object.values(columns)) identifier(name);

      const handle = Object.freeze({}) as DatasetResource;

      resources.set(handle, Object.freeze({ table, columns }));

      return handle;
    },
    close() {
      closed = true;

      return runner.close();
    },
  };
}
