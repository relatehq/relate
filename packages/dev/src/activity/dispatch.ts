/**
 * The routing boundary's view of one graph operation: what the caller asked
 * for and what the transport answered. The runtime records the operation
 * itself (specs/2026-10-13-activity.md); its forwarded row joins this event
 * by operation ID (see `projection.ts`) and is authoritative for the outcome.
 *
 * This event is transient development display state: a running indicator,
 * bounded request previews, and the error the caller saw. A call that never
 * reached the engine (a retired or lost runtime) has only this event, and it
 * says what the transport reported, never an engine result.
 *
 * Arguments arrive unvalidated (agent code can pass anything), so every
 * summary is defensive.
 */
import type {
  OperationContext,
  OperationEvent,
} from '@relate/inspector/protocol';
import {
  activityLimits,
  preview,
  text,
  truncate,
  type ActivityLog,
} from './log.js';
import type { RuntimeOperation } from '../runtime-protocol.js';

type Request = OperationEvent['request'];

type Outcome = NonNullable<OperationEvent['outcome']>;

const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object'
    ? (value as Record<string, unknown>)
    : {};

/** A bounded string, or undefined when the value is not one. */
const asString = (value: unknown): string | undefined =>
  typeof value === 'string' ? text(value) : undefined;

/** The read options worth showing: selection, filter, paging. */
function readRequest(value: unknown): Request {
  const request = record(value);
  const select = Array.isArray(request.select)
    ? request.select
        .filter((item): item is string => typeof item === 'string')
        .slice(0, 50)
        .map(text)
    : undefined;

  return {
    ...(select ? { select } : {}),
    ...(request.where !== undefined ? { where: preview(request.where) } : {}),
    // NaN and Infinity have no JSON form; runtime validation reports them.
    ...(typeof request.limit === 'number' && Number.isFinite(request.limit)
      ? { limit: request.limit }
      : {}),
    ...(asString(request.cursor) ? { cursor: asString(request.cursor) } : {}),
  };
}

function describe(
  operation: RuntimeOperation,
  args: readonly unknown[],
): Request {
  const [, a, b, c] = args;

  switch (operation) {
    case 'get':
      return { objectId: text(a), ...readRequest(b) };
    case 'query':
      return readRequest(a);
    case 'traverse':
      return { objectId: text(a), traversal: text(b), ...readRequest(c) };
    case 'invoke': {
      const { input, idempotencyKey } = record(a);

      return {
        input: preview(input),
        ...(asString(idempotencyKey)
          ? { idempotencyKey: asString(idempotencyKey) }
          : {}),
      };
    }
    case 'getReceipt':
      return { invocationId: text(a) };
  }
}

/** Public protocol errors keep their code; anything else is `internal`. */
function failure(error: unknown): Outcome {
  const value = record(error);
  const code = asString(value.code) || 'internal';
  const issues =
    Array.isArray(value.issues) && value.issues.length
      ? preview(value.issues)
      : undefined;

  return {
    error: {
      code,
      ...(error instanceof Error
        ? { message: truncate(error.message, activityLimits.preview).text }
        : {}),
      ...(issues ? { issues } : {}),
    },
  };
}

/** Record a dispatched operation as running; settle it with the transport's answer. */
export function observeDispatch(
  log: ActivityLog,
  call: {
    readonly opId: string;
    readonly context: OperationContext;
    readonly operation: RuntimeOperation;
    readonly args: readonly unknown[];
  },
) {
  let request: Request;

  try {
    request = describe(call.operation, call.args);
  } catch {
    request = {};
  }

  const started = performance.now();
  const base = {
    kind: 'operation' as const,
    opId: call.opId,
    context: call.context,
    at: new Date().toISOString(),
    op: call.operation,
    definitionId: text(call.args[0]),
    request,
    recordIds: [],
  };

  log.record({ ...base, status: 'running' });

  return {
    succeeded() {
      log.record({
        ...base,
        status: 'succeeded',
        ms: performance.now() - started,
      });
    },
    failed(error: unknown) {
      log.record({
        ...base,
        status: 'failed',
        outcome: failure(error),
        ms: performance.now() - started,
      });
    },
  };
}
