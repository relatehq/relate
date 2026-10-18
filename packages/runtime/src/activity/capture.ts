import { AsyncLocalStorage } from 'node:async_hooks';
import { ActionError, ReadError } from '@relate/protocol';
import type {
  ActivityActor,
  OperationContext,
  Operation,
  OperationOutcome,
  OperationObject,
} from '@relate/protocol';
import type {
  ActivityCaptureOptions,
  ActivityDiagnostic,
  ActivityStore,
  OperationDraft,
  AcceptanceProvenance,
} from 'relate/storage';
import { activityBytes, activityId, validateContext } from './records.js';

export interface OperationScope {
  readonly id: string;
  readonly actor: Exclude<ActivityActor, { kind: 'source' }>;
  readonly context: OperationContext;
  readonly parent?: {
    readonly id: string;
    readonly actor: Exclude<ActivityActor, { kind: 'source' }>;
  };
}

interface ActiveOperation {
  scope: OperationScope;
  startedAt: string;
  replayed: boolean;
}

const current = new AsyncLocalStorage<ActiveOperation>();

export function operationScope() {
  return current.getStore();
}

export function markReplay() {
  const active = current.getStore();

  if (active) active.replayed = true;
}

export function acceptanceProvenance(): AcceptanceProvenance | undefined {
  const active = current.getStore();

  return active
    ? {
        actor: active.scope.actor,
        operationId: active.scope.id,
        context: active.scope.context,
        occurredAt: new Date().toISOString(),
        changeId: activityId(),
        ...(active.scope.parent
          ? { parentOperationId: active.scope.parent.id }
          : {}),
      }
    : undefined;
}

export function newOperationScope(
  actor: OperationScope['actor'],
  context: Partial<OperationContext> = {},
): OperationScope {
  const snapshot = structuredClone({
    requestId: activityId(),
    transport: 'embedded' as const,
    ...context,
  });

  validateContext(snapshot);

  return { id: activityId(), actor: structuredClone(actor), context: snapshot };
}

export function operationFailure(error: unknown): OperationOutcome {
  if (error instanceof Error && error.name === 'RetentionError')
    return (error as Error & { outcome?: string }).outcome === 'unconfirmed'
      ? { status: 'uncertain' }
      : { status: 'rejected', code: 'unavailable' };

  if (error instanceof ActionError && error.code === 'uncertain')
    return { status: 'uncertain' };

  return {
    status: 'rejected',
    code:
      error instanceof ReadError || error instanceof ActionError
        ? (error.code as Exclude<ActionError['code'], 'uncertain'>)
        : 'internal',
  };
}

export function createActivityCapture(
  graphId: string,
  definitionRevision: string,
  store: ActivityStore | undefined,
  config: ActivityCaptureOptions = {},
) {
  const limits = {
    maxEntries: 1024,
    maxBytes: 4 * 1024 * 1024,
    maxObjects: 1000,
    batchEntries: 100,
    flushTimeoutMs: 2000,
    ...config,
  };

  for (const name of [
    'maxEntries',
    'maxBytes',
    'maxObjects',
    'batchEntries',
    'flushTimeoutMs',
  ] as const)
    if (!Number.isSafeInteger(limits[name]) || limits[name] < 1)
      throw new Error('Invalid activity capture limit');

  let queue: OperationDraft[] = [],
    retained = 0,
    count = 0,
    writing = false,
    closed = false;
  const counters = { dropped: 0, truncated: 0 };
  const waiters = new Set<() => void>();
  const diagnostic = (
    code: ActivityDiagnostic['code'],
    rows: readonly OperationDraft[],
    n = rows.length,
  ) => {
    if (code === 'truncated') counters.truncated += n;
    else counters.dropped += n;

    try {
      const result = config.onError?.({
        code,
        count: n,
        kinds: [...new Set(rows.map((r) => r.kind))],
      });

      void Promise.resolve(result).catch(() => {});
    } catch {
      /* Host diagnostics cannot affect execution. */
    }
  };
  const pump = () => {
    if (writing || !queue.length || !store) return;

    writing = true;
    const batch = queue.splice(0, limits.batchEntries),
      bytes = batch.reduce((n, r) => n + activityBytes(r), 0);

    void Promise.resolve()
      .then(() => store.appendOperations(graphId, batch))
      .catch(() => {
        if (!closed) diagnostic('write-failed', batch);
      })
      .finally(() => {
        retained -= bytes;
        count -= batch.length;
        writing = false;

        if (!closed) pump();

        if (!writing && !queue.length) for (const done of waiters) done();
      });
  };
  const enqueue = (draft: OperationDraft) => {
    if (!store || config.enabled === false || closed) return;

    let row = structuredClone(draft);

    if (row.objects.length > limits.maxObjects) {
      const omittedObjects = row.objects.length - limits.maxObjects;

      row = {
        ...row,
        objects: row.objects.slice(0, limits.maxObjects),
        details: { ...row.details, truncated: { omittedObjects } },
      } as OperationDraft;
      diagnostic('truncated', [row], omittedObjects);
    }

    const bytes = activityBytes(row);

    if (count + 1 > limits.maxEntries || retained + bytes > limits.maxBytes) {
      diagnostic('overflow', [row]);

      return;
    }

    queue.push(row);
    count++;
    retained += bytes;
    queueMicrotask(pump);
  };
  const run = async <T>(
    scope: OperationScope,
    kind: Operation['kind'],
    definitionId: string,
    operation: () => Promise<T>,
    describe: (result: T) => Record<string, unknown>,
    initial: Record<string, unknown> = {},
  ): Promise<T> => {
    const startedAt = new Date().toISOString(),
      start = performance.now();
    const active = {
      scope: structuredClone(scope),
      startedAt,
      replayed: false,
    };

    return current.run(active, async () => {
      let fields: Record<string, unknown> = {
        objects: [],
        details: {},
        ...initial,
      };

      try {
        const result = await operation();

        fields = { ...fields, ...describe(result) };

        return result;
      } catch (error) {
        fields = { ...fields, outcome: operationFailure(error) };
        throw error;
      } finally {
        if (kind === 'invoke')
          fields.replayed = Boolean(fields.invocationId) && active.replayed;

        enqueue({
          schemaVersion: 1,
          id: scope.id,
          graphId,
          definitionRevision,
          actor: scope.actor,
          context: scope.context,
          ...(scope.parent ? { parentOperationId: scope.parent.id } : {}),
          kind,
          definitionId,
          startedAt,
          completedAt: new Date().toISOString(),
          durationMs: Math.max(0, performance.now() - start),
          ...fields,
        } as OperationDraft);
      }
    });
  };

  return {
    run,
    enqueue,
    counters,
    async flush() {
      if (!writing && !queue.length) return;

      await new Promise<void>((resolve) => {
        const finish = () => {
          clearTimeout(timer);
          waiters.delete(finish);
          resolve();
        };
        const timer = setTimeout(() => {
          diagnostic('shutdown', queue, count);
          queue = [];
          closed = true;
          finish();
        }, limits.flushTimeoutMs);

        waiters.add(finish);
        pump();
      });
    },
    async refresh<T>(
      definitionId: string,
      objectId: string,
      operation: () => Promise<T>,
      describe: (result: T) => { outcome: OperationOutcome; details: object },
    ) {
      const parent = current.getStore()?.scope;

      if (!parent) return operation();

      const scope = {
        ...newOperationScope(parent.actor, parent.context),
        parent: { id: parent.id, actor: parent.actor },
      };
      const target = { objectDefinitionId: definitionId, objectId };

      return run(scope, 'refresh', definitionId, operation, describe, {
        target,
        objects: [emptyObject(target, 'target')],
      });
    },
  };
}

export function emptyObject(
  ref: { objectDefinitionId: string; objectId: string },
  role: OperationObject['role'],
): OperationObject {
  return { ...ref, role, returned: [], forbidden: [], unavailable: [] };
}
