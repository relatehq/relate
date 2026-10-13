/**
 * L3: observe graph operations. Shared by every transport: the context names
 * the request and runtime, and carries an `executionId` only when agent
 * JavaScript made the call, so a future `/api` request appears in the same
 * timeline without inventing an execution.
 *
 * Arguments arrive unvalidated (agent code can pass anything), so every
 * summary is defensive and the call itself always goes to the inner
 * operations unchanged.
 */
import { randomUUID } from 'node:crypto';
import type { ConsumerOperations } from '@relate/protocol';
import type {
  OperationContext,
  OperationEvent,
} from '@relate/inspector/protocol';
import { activityLimits, preview, type ActivityLog } from './log.js';

type Operation = OperationEvent['op'];

type Request = OperationEvent['request'];

type Outcome = NonNullable<OperationEvent['outcome']>;

const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object'
    ? (value as Record<string, unknown>)
    : {};

const asString = (value: unknown): string | undefined =>
  typeof value === 'string' ? value : undefined;

/** The read options worth showing: selection, filter, paging. */
function readRequest(value: unknown): Request {
  const request = record(value);
  const select = Array.isArray(request.select)
    ? request.select.filter((item): item is string => typeof item === 'string')
    : undefined;

  return {
    ...(select ? { select: select.slice(0, 50) } : {}),
    ...(request.where !== undefined ? { where: preview(request.where) } : {}),
    ...(typeof request.limit === 'number' ? { limit: request.limit } : {}),
    ...(asString(request.cursor) ? { cursor: asString(request.cursor) } : {}),
  };
}

function warnings(value: unknown): number {
  const meta = record(record(value).meta);

  return Array.isArray(meta.warnings) ? meta.warnings.length : 0;
}

/** Counts and IDs of what came back; record values are never kept. */
function summarize(value: unknown): {
  readonly outcome: Outcome;
  readonly recordIds: string[];
} {
  const result = record(value);

  if (result.status === 'not-found')
    return { outcome: { found: false }, recordIds: [] };

  if (result.status === 'ok') {
    const id = asString(result.id);
    const evidenceWarnings = warnings(result);

    return {
      outcome: {
        found: true,
        ...(evidenceWarnings ? { evidenceWarnings } : {}),
      },
      recordIds: id ? [id] : [],
    };
  }

  if (Array.isArray(result.data)) {
    const data = result.data.map(record);
    const evidenceWarnings = data.reduce(
      (sum, item) => sum + warnings(item),
      0,
    );

    return {
      outcome: {
        records: data.length,
        hasMore: record(result.meta).exhausted === false,
        ...(evidenceWarnings ? { evidenceWarnings } : {}),
      },
      recordIds: data
        .map((item) => asString(item.id))
        .filter((id): id is string => id !== undefined)
        .slice(0, activityLimits.recordIds),
    };
  }

  if (typeof result.state === 'string')
    return {
      outcome: {
        receiptState: result.state,
        ...(asString(result.invocationId)
          ? { invocationId: asString(result.invocationId) }
          : {}),
      },
      recordIds: [],
    };

  return { outcome: {}, recordIds: [] };
}

/** Public protocol errors keep their code; anything else is `internal`. */
function failure(error: unknown): Outcome {
  const value = record(error);
  const code = asString(value.code) ?? 'internal';
  const issues =
    Array.isArray(value.issues) && value.issues.length
      ? preview(value.issues)
      : undefined;

  return {
    error: {
      code,
      ...(error instanceof Error ? { message: error.message } : {}),
      ...(issues ? { issues } : {}),
    },
  };
}

export function observeOperations(
  operations: ConsumerOperations,
  log: ActivityLog,
  context: OperationContext,
): ConsumerOperations {
  const observe = async <T>(
    op: Operation,
    definitionId: unknown,
    request: () => Request,
    call: () => Promise<T>,
  ): Promise<T> => {
    let summary: Request;

    try {
      summary = request();
    } catch {
      summary = {};
    }

    const started = performance.now();
    const base = {
      kind: 'operation' as const,
      opId: randomUUID(),
      context,
      at: new Date().toISOString(),
      op,
      definitionId: String(definitionId),
      request: summary,
    };

    log.record({ ...base, status: 'running', recordIds: [] });

    try {
      const value = await call();
      const { outcome, recordIds } = summarize(value);

      log.record({
        ...base,
        status: 'succeeded',
        outcome,
        recordIds,
        ms: performance.now() - started,
      });

      return value;
    } catch (error) {
      log.record({
        ...base,
        status: 'failed',
        outcome: failure(error),
        recordIds: [],
        ms: performance.now() - started,
      });

      throw error;
    }
  };

  return Object.freeze({
    discovery: operations.discovery,
    get: (definitionId, objectId, request) =>
      observe(
        'get',
        definitionId,
        () => ({ objectId: String(objectId), ...readRequest(request) }),
        () => operations.get(definitionId, objectId, request),
      ),
    query: (definitionId, request) =>
      observe(
        'query',
        definitionId,
        () => readRequest(request),
        () => operations.query(definitionId, request),
      ),
    traverse: (definitionId, objectId, traversal, request) =>
      observe(
        'traverse',
        definitionId,
        () => ({
          objectId: String(objectId),
          traversal: String(traversal),
          ...readRequest(request),
        }),
        () => operations.traverse(definitionId, objectId, traversal, request),
      ),
    invoke: (definitionId, request) =>
      observe(
        'invoke',
        definitionId,
        () => {
          const { input, idempotencyKey } = record(request);

          return {
            input: preview(input),
            ...(asString(idempotencyKey)
              ? { idempotencyKey: asString(idempotencyKey) }
              : {}),
          };
        },
        () => operations.invoke(definitionId, request),
      ),
    getReceipt: (definitionId, invocationId) =>
      observe(
        'getReceipt',
        definitionId,
        () => ({ invocationId: String(invocationId) }),
        () => operations.getReceipt(definitionId, invocationId),
      ),
  } satisfies ConsumerOperations);
}
