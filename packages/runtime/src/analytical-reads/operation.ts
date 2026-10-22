import { ReadError } from '@relate/protocol';
import type { AnalyticalLimits } from 'relate/analytics';
import type { ReadExecution } from '../reads/index.js';

/** One analytical read owns its deadline, retirement listener and source-call budget. */
export function createAnalyticalOperation(options: {
  readonly operation: string;
  readonly limits: Required<AnalyticalLimits>;
  readonly signal: AbortSignal;
  readonly started: number;
  readonly timeoutMs?: number;
}) {
  const { operation, limits, signal, started, timeoutMs } = options;
  const controller = new AbortController();
  let sourceCalls = 0;
  const execution: ReadExecution = {
    expandedSelection: true,
    signal: controller.signal,
    beforeSourceCall() {
      controller.signal.throwIfAborted();

      if (sourceCalls >= limits.maxSourceCalls) {
        controller.abort(
          new ReadError('resource-exhausted', {
            operation,
            issues: [
              {
                path: [],
                problem: 'limit-exceeded',
                message:
                  'The analytical query exceeds the source-call budget. Ask the host to review the population scan, source-call and admission budgets.',
              },
            ],
          }),
        );
        controller.signal.throwIfAborted();
      }

      sourceCalls++;
    },
  };
  const retire = () => controller.abort(new ReadError('runtime-retired'));

  signal.addEventListener('abort', retire, { once: true });

  if (signal.aborted) retire();

  const remaining =
    Math.min(timeoutMs ?? Infinity, limits.operationTimeoutMs) -
    (performance.now() - started);

  if (remaining <= 0) controller.abort(new ReadError('unavailable'));

  const timer = setTimeout(
    () => controller.abort(new ReadError('unavailable')),
    Math.max(0, remaining),
  );

  return {
    controller,
    execution,
    close() {
      clearTimeout(timer);
      signal.removeEventListener('abort', retire);
    },
  };
}
