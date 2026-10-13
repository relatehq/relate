/**
 * L2: observe code executions. The inner executor receives a per-execution
 * binding whose operations are observed with this execution's ID, which is how
 * every graph operation links back to the code that made it.
 */
import { randomUUID } from 'node:crypto';
import type { CodeExecutor, ExecutionResult } from '@relate/mcp';
import type {
  ExecutionEvent,
  OperationContext,
} from '@relate/inspector/protocol';
import { activityLimits, preview, truncate, type ActivityLog } from './log.js';
import { observeOperations } from './operations.js';

function boundedLogs(result: ExecutionResult): {
  readonly logs: ExecutionEvent['logs'];
  readonly logsTruncated: boolean;
} {
  const logs: { stream: 'stdout' | 'stderr'; text: string }[] = [];
  let remaining = activityLimits.logs;

  for (const entry of result.logs) {
    if (remaining <= 0) return { logs, logsTruncated: true };

    const { text, truncated } = truncate(entry.text, remaining);

    logs.push({ stream: entry.stream, text });
    remaining -= entry.text.length;

    if (truncated) return { logs, logsTruncated: true };
  }

  return { logs, logsTruncated: false };
}

export function observeExecutor(
  inner: CodeExecutor,
  log: ActivityLog,
  request: Omit<OperationContext, 'executionId'>,
): CodeExecutor {
  return {
    async execute({ code, graph, signal }) {
      const executionId = randomUUID();
      const observed = {
        ...graph,
        operations: observeOperations(graph.operations, log, {
          ...request,
          executionId,
        }),
      };
      const source = truncate(code, activityLimits.code);
      const started = performance.now();
      const base = {
        kind: 'execution' as const,
        executionId,
        requestId: request.requestId,
        runtimeId: request.runtimeId,
        principal: request.principal,
        at: new Date().toISOString(),
        code: source.text,
        codeTruncated: source.truncated,
      };

      log.record({
        ...base,
        status: 'running',
        logs: [],
        logsTruncated: false,
      });

      let result: ExecutionResult;

      try {
        result = await inner.execute({
          code,
          graph: observed,
          ...(signal ? { signal } : {}),
        });
      } catch (error) {
        log.record({
          ...base,
          status: 'failed',
          logs: [],
          logsTruncated: false,
          error: {
            name: 'Error',
            message: error instanceof Error ? error.message : String(error),
          },
          ms: performance.now() - started,
        });

        throw error;
      }

      log.record({
        ...base,
        ...boundedLogs(result),
        ms: performance.now() - started,
        ...(result.status === 'succeeded'
          ? { status: 'succeeded', resultPreview: preview(result.result) }
          : {
              status: 'failed',
              error: {
                name: result.error.name,
                message: truncate(result.error.message, activityLimits.preview)
                  .text,
                ...(result.error.code ? { code: result.error.code } : {}),
              },
            }),
      });

      return result;
    },
  };
}
