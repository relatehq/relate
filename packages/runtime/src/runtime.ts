import type { ReadExecution } from './reads/index.js';
import { createAnalyticalReads } from './reads/analytical.js';
import type { AnalyticalReadOptions } from './reads/analytical.js';
import {
  createNativeOperations,
  nativeEvidence,
  createActionExecutor,
} from './actions/index.js';
import type { ActionHandler } from './actions/index.js';
import type { NativeTransaction, StorageScope } from './storage.js';
import { createGraphQuery, createQueryCursors } from './queries/index.js';
import { createTraversal, traversalsFrom } from './traversal/index.js';
import {
  createSourceOperations,
  classifyAdoptionFailure,
} from './resolution/index.js';
import {
  createCapture,
  createOperationRecorder,
  createOperationScope,
  createOperationDescriptions,
} from './activity/index.js';
import type {
  ActivityCaptureOptions,
  OperationScope,
} from './activity/index.js';
import type { SourceBinding } from 'relate/connectors';
import { createMemoryStore } from './memory.js';
import {
  presenting,
  calculatedReadIssues,
  rejectIssues,
} from './reads/index.js';
import { createHash } from 'node:crypto';
import { canonicalJson, validateManifest } from 'relate/model';
import type { CompiledModel } from 'relate/model';
import { ActivityError } from '@relate/protocol';
import type {
  ActivityObjectRef,
  ActivityReader,
  ActivityStatus,
  ObjectProvenance,
  OperationActor,
  QueryRequest,
  ReadRequest,
  TraversalRequest,
  FullObjectResult as ReadResult,
} from '@relate/protocol';
import type { ObservationStore } from './storage.js';
import type { Principal } from './authorization/index.js';
import {
  allowsObject,
  allowsField,
  operationName,
} from './authorization/index.js';
import { createDiscovery } from './discovery.js';
import { resolveAnalyticalLimits } from './analytics/index.js';

export interface RuntimeOptions {
  readonly model: CompiledModel;
  readonly graphId: string;
  readonly store?: ObservationStore;
  readonly sources: Readonly<Record<string, SourceBinding>>;
  readonly clock?: () => number;
  /** Share a 32-byte key across trusted runtimes to preserve cursor validity. */
  readonly cursorKey?: Uint8Array;
  readonly actionHandlers?: Readonly<Record<string, ActionHandler>>;
  /** Native callback budget after lock acquisition, 1–60,000 ms; defaults to 60,000. */
  readonly actionTimeoutMs?: number;
  /** Operation capture configuration; the feed and provenance are always recorded. */
  readonly activity?: ActivityCaptureOptions;
  readonly analytics?: AnalyticalReadOptions;
}

/** Trusted host operations without an explicit actor are attributed to this one. */
export const hostActor: OperationActor = Object.freeze({
  kind: 'system',
  id: 'relate.host',
});

const nonblank = (value: unknown): value is string =>
  typeof value === 'string' && value.trim().length > 0;

export function createRuntime(options: RuntimeOptions) {
  const analytics = options.analytics
    ? {
        ...options.analytics,
        limits: resolveAnalyticalLimits(options.analytics.limits),
      }
    : undefined;
  const actionTimeoutMs = options.actionTimeoutMs ?? 60_000;

  if (
    !Number.isInteger(actionTimeoutMs) ||
    actionTimeoutMs < 1 ||
    actionTimeoutMs > 60_000
  )
    throw new Error('actionTimeoutMs must be an integer between 1 and 60000');

  const manifest = validateManifest(options.model.manifest);
  const revision = `sha256:${createHash('sha256').update(canonicalJson(manifest)).digest('hex')}`;

  if (revision !== options.model.definitionRevision || !options.graphId.trim())
    throw new Error('Invalid compiled model or graph instance');

  const store = options.store ?? createMemoryStore(),
    clock = options.clock ?? Date.now;

  // A store advertising activity must record feed entries atomically for
  // every write capability it exposes; a best-effort sink cannot claim that.
  if (
    store.activity &&
    (store.activity.atomicFeed?.sourceAcceptance !== true ||
      (store.native && store.activity.atomicFeed.nativeTransactions !== true))
  )
    throw new Error(
      'Store advertises activity without atomic feed recording for every write capability',
    );

  const sources = Object.fromEntries(
    Object.entries(options.sources).map(([id, source]) => [id, { ...source }]),
  );

  for (const resource of manifest.sources) {
    const binding = sources[resource.id];

    if (
      !binding ||
      !binding.connectionId.trim() ||
      typeof binding.resourceId !== 'string' ||
      !binding.resourceId.trim() ||
      (binding.connector.identity === 'application'
        ? binding.providerAccountId !== undefined ||
          binding.connector.identify !== undefined
        : (binding.connector.identity !== undefined &&
            binding.connector.identity !== 'provider') ||
          typeof binding.providerAccountId !== 'string' ||
          !binding.providerAccountId.trim() ||
          typeof binding.connector.identify !== 'function') ||
      binding.authorization !== 'shared-service' ||
      typeof binding.connector.fetch !== 'function'
    )
      throw new Error('Missing or unsupported source binding');
  }

  // Only fulfilled installation is cached; a failed attempt can be retried.
  let installation: Promise<void> | undefined;
  const install = () =>
    (installation ??= store
      .install(options.graphId, revision)
      .catch((error) => {
        installation = undefined;
        throw error;
      }));
  const scopeFor = (
    objectDefinitionId: string,
    sourceDefinitionId: string,
  ): StorageScope => ({
    graphId: options.graphId,
    definitionRevision: revision,
    objectDefinitionId,
    sourceDefinitionId,
    connectionId: sources[sourceDefinitionId]!.connectionId,
    resourceId: sources[sourceDefinitionId]!.resourceId,
    providerAccountId: sources[sourceDefinitionId]!.providerAccountId ?? null,
    partition: 'shared-service',
  });

  const nativeScope = {
    graphId: options.graphId,
    definitionRevision: revision,
  };

  async function resolveEvidence(
    attempt: OperationScope,
    target: (typeof manifest.objects)[number],
    key: string,
    maxAgeMs: number,
    canonical = false,
    transaction?: NativeTransaction,
    request: ReadRequest = {},
    execution?: ReadExecution,
  ) {
    execution?.signal.throwIfAborted();

    if (!target.sourceDefinitionId) {
      const record = transaction
        ? await transaction.load(target.id, key)
        : await store.native?.load(nativeScope, target.id, key);

      return record ? nativeEvidence(target, record) : undefined;
    }

    return source.resolveSourceEvidence(
      attempt,
      target,
      key,
      maxAgeMs,
      canonical,
      request,
      execution,
    );
  }

  const recorder = createOperationRecorder({
    ...(store.activity ? { store: store.activity } : {}),
    graphId: options.graphId,
    ...(options.activity ? { capture: options.activity } : {}),
  });
  const capture = createCapture({
    graphId: options.graphId,
    definitionRevision: revision,
    recorder,
  });
  const describe = createOperationDescriptions(
    manifest,
    classifyAdoptionFailure,
  );
  const source = createSourceOperations({
    manifest,
    revision,
    store,
    sources,
    clock,
    install,
    scopeFor,
    capture,
    resolve: resolveEvidence,
  });
  const native = createNativeOperations({
    manifest,
    scope: nativeScope,
    store,
    clock,
    install,
    resolve: resolveEvidence,
  });

  async function readObject(
    attempt: OperationScope,
    principal: Principal,
    objectDefinitionId: string,
    objectId: string,
    request: ReadRequest = {},
    requiredReference?: string,
    captureAuthorization?: (check: () => Promise<boolean>) => void,
    transaction?: NativeTransaction,
    execution?: ReadExecution,
  ): Promise<ReadResult> {
    execution?.signal.throwIfAborted();
    const object = manifest.objects.find((o) => o.id === objectDefinitionId);
    const policy = manifest.policies[objectDefinitionId];

    if (transaction && request?.compute !== undefined)
      rejectIssues(
        operationName(manifest, principal, objectDefinitionId, 'get'),
        'get',
        [
          {
            path: ['compute'],
            problem: 'not-supported',
            message:
              'Analytical reads are not supported in action transactions.',
          },
        ],
      );

    if (transaction && object && allowsObject(principal, policy))
      rejectIssues(
        operationName(manifest, principal, objectDefinitionId, 'get'),
        'get',
        calculatedReadIssues(
          request,
          (object.calculations ?? []).map((property) => ({
            name: property.name,
            defaultSelected: allowsField(principal, policy!, property.access),
          })),
        ),
      );

    if (object?.sourceDefinitionId)
      return source.read(
        attempt,
        principal,
        objectDefinitionId,
        objectId,
        request,
        requiredReference,
        captureAuthorization,
        transaction,
        execution,
      );

    return native.read(
      attempt,
      principal,
      objectDefinitionId,
      objectId,
      request,
      transaction,
      captureAuthorization,
      execution,
    );
  }

  const queryCursors = createQueryCursors({
    manifest,
    scope: nativeScope,
    clock,
    scopeFor,
    ...(options.cursorKey ? { cursorKey: options.cursorKey } : {}),
  });
  const query = createGraphQuery({
    manifest,
    scope: nativeScope,
    store,
    clock,
    install,
    scopeFor,
    read: readObject,
    cursors: queryCursors,
  });

  const analyticalReads = createAnalyticalReads({
    manifest,
    cursors: queryCursors,
    read: (
      attempt,
      principal,
      type,
      id,
      request,
      reference,
      capture,
      execution,
    ) =>
      readObject(
        attempt,
        principal,
        type,
        id,
        request,
        reference,
        capture,
        undefined,
        execution,
      ),
    query: (attempt, principal, type, request, context) =>
      query(attempt, principal, type, request, undefined, undefined, context),
    clock,
    ...(analytics ? { analytics } : {}),
  });

  const traverse = createTraversal({
    manifest,
    graphId: options.graphId,
    revision,
    store,
    clock,
    scopeFor,
    read: readObject,
    ...(options.cursorKey ? { cursorKey: options.cursorKey } : {}),
  });

  /** The authenticated principal is the actor; a supplied scope cannot change it. */
  function consumerScope(principal: Principal, scope?: OperationScope) {
    if (!scope)
      return createOperationScope({ kind: 'principal', id: principal.id });

    if (scope.actor.kind !== 'principal' || scope.actor.id !== principal.id)
      throw new Error('Operation scope actor must be the bound principal');

    return scope;
  }

  const executor = createActionExecutor({
    query,
    manifest,
    scope: nativeScope,
    store,
    clock,
    timeoutMs: actionTimeoutMs,
    install,
    handlers: options.actionHandlers ?? {},
    validate: native.validate,
    read: (
      attempt,
      actor,
      type,
      id,
      request,
      transaction,
      captureAuthorization,
    ) =>
      readObject(
        attempt,
        actor,
        type,
        id,
        request,
        undefined,
        captureAuthorization,
        transaction,
      ),
  });

  /** Trusted readers: unsupported is never an empty history. */
  async function activityCall<T>(
    read: (activity: NonNullable<typeof store.activity>) => Promise<T>,
  ): Promise<T> {
    if (!store.activity) throw new ActivityError('unsupported');

    try {
      await install();

      return await read(store.activity);
    } catch (error) {
      if (error instanceof ActivityError) throw error;

      throw new ActivityError('unavailable', { cause: error });
    }
  }

  const activity: ActivityReader = Object.freeze({
    async status(): Promise<ActivityStatus> {
      return store.activity
        ? {
            state: 'available',
            durability: store.durability,
            operationCapture: recorder.enabled ? 'enabled' : 'disabled',
          }
        : { state: 'unsupported' };
    },
    feed: Object.freeze({
      read: (readOptions?: Parameters<ActivityReader['feed']['read']>[0]) =>
        activityCall((a) => a.feed.read(options.graphId, readOptions)),
    }),
    operations: Object.freeze({
      list: (
        readOptions?: Parameters<ActivityReader['operations']['list']>[0],
      ) => activityCall((a) => a.operations.list(options.graphId, readOptions)),
    }),
  });

  return {
    discover: (principal: Principal) =>
      createDiscovery(
        { manifest, definitionRevision: revision },
        principal,
        analytics?.parser,
        analytics?.limits,
      ),
    /** Trusted host ingestion, attributed to the host actor or the scope's actor. */
    adopt(
      objectDefinitionId: string,
      sourceRecordId: string,
      scope: OperationScope = createOperationScope(hostActor),
    ): Promise<string> {
      return capture.operation(
        scope,
        () => source.adopt(objectDefinitionId, sourceRecordId, scope),
        describe.adopt(objectDefinitionId),
      );
    },
    async query(
      principal: Principal,
      objectDefinitionId: string,
      request: QueryRequest = {},
      scope?: OperationScope,
    ) {
      const attempt = consumerScope(principal, scope);

      return presenting(request, (r) =>
        capture.operation(
          attempt,
          () =>
            analyticalReads.query(attempt, principal, objectDefinitionId, r),
          describe.query(objectDefinitionId),
        ),
      );
    },
    async read(
      principal: Principal,
      objectDefinitionId: string,
      objectId: string,
      request: ReadRequest = {},
      scope?: OperationScope,
    ) {
      const attempt = consumerScope(principal, scope);

      return presenting(request, (r) =>
        capture.operation(
          attempt,
          () =>
            analyticalReads.get(
              attempt,
              principal,
              objectDefinitionId,
              objectId,
              r,
            ),
          describe.get(objectDefinitionId, objectId),
        ),
      );
    },
    async invoke(
      principal: Principal,
      actionId: string,
      request: { input: unknown; idempotencyKey: string },
      scope?: OperationScope,
    ) {
      const attempt = consumerScope(principal, scope);

      return capture
        .operation(
          attempt,
          () => executor.invoke(principal, actionId, request, attempt),
          describe.invoke(actionId),
        )
        .then(({ receipt }) => receipt);
    },
    async getReceipt(
      principal: Principal,
      actionId: string,
      invocationId: string,
      scope?: OperationScope,
    ) {
      const attempt = consumerScope(principal, scope);

      return capture.operation(
        attempt,
        () => executor.getReceipt(principal, actionId, invocationId, attempt),
        describe.receipt(actionId),
      );
    },
    async traverse(
      principal: Principal,
      typeId: string,
      id: string,
      name: string,
      request: TraversalRequest = {},
      scope?: OperationScope,
    ) {
      const attempt = consumerScope(principal, scope);
      const edge = traversalsFrom(manifest, typeId).find(
        ({ relationship, forward }) =>
          (forward ? relationship.forward : relationship.reverse).name === name,
      );
      const resultType = edge
        ? edge.forward
          ? edge.relationship.toObjectDefinitionId
          : edge.relationship.fromObjectDefinitionId
        : typeId;

      return presenting(request, (r) =>
        capture.operation(
          attempt,
          () => traverse(attempt, principal, typeId, id, name, r),
          describe.traverse(
            resultType,
            { objectDefinitionId: typeId, objectId: id },
            // An unknown name has no relationship; the traversal rejects it.
            edge?.relationship.id ?? String(name),
          ),
        ),
      );
    },
    /** Trusted host activity reading; never exposed to consumers. */
    activity,
    /** Who created or adopted an object, from object storage only. */
    async provenance(
      object: ActivityObjectRef,
    ): Promise<ObjectProvenance | undefined> {
      if (
        !object ||
        typeof object !== 'object' ||
        !nonblank(object.objectDefinitionId) ||
        !nonblank(object.objectId)
      )
        throw new ActivityError('invalid-request');

      const definition = manifest.objects.find(
        (o) => o.id === object.objectDefinitionId,
      );

      if (!definition) return undefined;

      try {
        await install();

        if (definition.sourceDefinitionId)
          return await store.provenance(
            scopeFor(definition.id, definition.sourceDefinitionId),
            object.objectId,
          );

        return await store.native?.provenance(nativeScope, {
          objectDefinitionId: object.objectDefinitionId,
          objectId: object.objectId,
        });
      } catch (error) {
        throw new ActivityError('unavailable', { cause: error });
      }
    },
    /** Operation-capture drop and truncation counters. */
    activityCounters: () => recorder.counters(),
    /** Wait for captured operations to be appended, without closing. */
    flushActivity: (deadlineMs: number) => recorder.flush(deadlineMs),
    /** Flush captured operations within the deadline; reports abandonment. */
    drainActivity: (deadlineMs: number) => recorder.drain(deadlineMs),
  };
}
