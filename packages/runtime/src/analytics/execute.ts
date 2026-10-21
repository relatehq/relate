import { DatasetExecutionError } from 'relate/connectors';
import { AnalyticalBusyError } from './queue.js';
import type { StatementQueue } from './queue.js';
import { initializeRows, planBatches } from './batch.js';
import type { CalculationBatch } from './batch.js';
import { invalidate, mergeBatch, finishScope } from './merge.js';
import type {
  ResolvedCalculation,
  AuthorizedCandidate,
  AnalyticalBinding,
  ComputedScope,
} from './execution-types.js';
import type { TimingCapture } from './timings.js';
import { beginTiming, recordTiming } from './timings.js';
import { preparedFields } from './prepared.js';
import type { PreparedCompute } from './prepared.js';
import { captureCalculations } from './activity.js';
import type { CalculationCapture } from './activity.js';

/** Request-local execution over authorized, materialized ordinary dependencies. */
export async function executeResolvedFields(input: {
  readonly fields: readonly ResolvedCalculation[];
  readonly candidates: readonly AuthorizedCandidate[];
  readonly binding: (datasetId: string) => AnalyticalBinding;
  readonly signal: AbortSignal;
  readonly maxSlots?: number;
  readonly statementTimeoutMs?: number;
  readonly maxConcurrentStatements?: number;
  readonly requireComplete?: boolean;
  readonly timings?: TimingCapture;
  readonly activity?: CalculationCapture;
  readonly clock?: () => number;
}): Promise<ComputedScope> {
  input.signal.throwIfAborted();

  if (
    new Set(input.fields.map((field) => field.name)).size !==
    input.fields.length
  )
    throw new Error('Duplicate analytical field');

  const timeoutMs = input.statementTimeoutMs ?? 5000;
  const concurrency = input.maxConcurrentStatements ?? 4;

  if (
    !Number.isSafeInteger(concurrency) ||
    concurrency < 1 ||
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < 1 ||
    timeoutMs > 2147483647
  )
    throw new Error('Invalid analytical statement timeout');

  const endPlanning = beginTiming(input.timings, 'planning');
  let rows: ReturnType<typeof initializeRows>;
  let batches: CalculationBatch[];

  try {
    rows = initializeRows(input.fields, input.candidates);
    batches = planBatches({
      fields: input.fields,
      rows,
      binding: input.binding,
      maxSlots: input.maxSlots ?? 1000,
    });
  } finally {
    endPlanning();
  }

  const controller = new AbortController();
  const abort = () => controller.abort(input.signal.reason);

  input.signal.addEventListener('abort', abort, { once: true });

  if (input.signal.aborted) abort();

  const failed = new Set<string>();
  const connections = new Map<StatementQueue, CalculationBatch[]>();

  for (const batch of batches) {
    const group = connections.get(batch.binding.queue) ?? [];

    group.push(batch);
    connections.set(batch.binding.queue, group);
  }

  const execute = async (batch: CalculationBatch) => {
    if (batch.fields.every((field) => failed.has(field.name))) return;

    controller.signal.throwIfAborted();

    try {
      const end = beginTiming(input.timings, 'planning');
      let plan: ReturnType<AnalyticalBinding['connector']['plan']>;

      try {
        plan = batch.binding.connector.plan(batch.query);
      } finally {
        end();
      }

      const result = await batch.binding.queue.run(
        (signal) =>
          batch.binding.connector.execute(plan, {
            signal,
            timeoutMs,
            onTiming: (timing) =>
              recordTiming(input.timings, timing.stage, timing.durationMs),
          }),
        {
          signal: controller.signal,
          onWait: (duration) =>
            recordTiming(input.timings, 'queueWait', duration),
        },
      );

      controller.signal.throwIfAborted();
      const endMerge = beginTiming(input.timings, 'finalization');

      try {
        mergeBatch({
          batch,
          result,
          rows,
          failed,
          computedAt: new Date((input.clock ?? Date.now)()).toISOString(),
        });
      } finally {
        endMerge();
      }
    } catch (error) {
      if (controller.signal.aborted) throw controller.signal.reason;

      if (error instanceof Error && error.name === 'AbortError') throw error;

      const names = batch.fields.map((field) => field.name);

      for (const name of names) failed.add(name);

      invalidate(rows, names, {
        status: 'unavailable',
        reason:
          error instanceof AnalyticalBusyError
            ? 'busy'
            : error instanceof DatasetExecutionError &&
                error.code === 'invalid-result'
              ? 'invalid-result'
              : 'execution-failed',
        ...(error instanceof AnalyticalBusyError
          ? { retryable: true }
          : error instanceof DatasetExecutionError
            ? { retryable: error.retryable }
            : { retryable: true }),
      });
    }
  };

  try {
    const workers: Promise<void>[] = [];

    for (const group of connections.values()) {
      let cursor = 0;

      for (let i = 0; i < Math.min(concurrency, group.length); i++)
        workers.push(
          (async () => {
            try {
              while (cursor < group.length) {
                controller.signal.throwIfAborted();
                await execute(group[cursor++]!);
              }
            } catch (error) {
              controller.abort(error);
            }
          })(),
        );
    }

    // Never publish or finalize capture while another statement is still cleaning up.
    await Promise.allSettled(workers);
    controller.signal.throwIfAborted();
    const end = beginTiming(input.timings, 'finalization');

    let result: ComputedScope;

    try {
      result = finishScope(input.fields, rows, input.requireComplete ?? false);
    } finally {
      end();
    }

    controller.signal.throwIfAborted();

    return result;
  } finally {
    if (input.activity)
      for (const row of rows)
        captureCalculations(input.activity, (activity) =>
          activity.results(row.fields, undefined, controller.signal.aborted),
        );

    input.signal.removeEventListener('abort', abort);
  }
}

/** Execute one request-local preparation; callers cannot forge or reuse it. */
export async function computeFields(
  input: Omit<Parameters<typeof executeResolvedFields>[0], 'fields'> & {
    readonly prepared: PreparedCompute;
  },
): Promise<ComputedScope> {
  const { prepared, ...execution } = input;
  const fields = preparedFields(prepared);

  return executeResolvedFields({ ...execution, fields });
}
