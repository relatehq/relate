import {
  createActivityCapture,
  newOperationScope,
  emptyObject,
} from './activity/index.js';
import type { OperationScope } from './activity/index.js';
import { ActivityError } from '@relate/protocol';
import type {
  ActivityReader,
  ActivityObjectRef,
  OperationContext,
  FullObjectRecord,
  FullPageResult,
  ActionReceipt,
} from '@relate/protocol';
import type { ActivityCaptureOptions } from 'relate/storage';
import {
  createNativeOperations,
  nativeEvidence,
  createActionExecutor,
} from './actions/index.js';
import type { ActionHandler } from './actions/index.js';
import type { NativeTransaction, StorageScope } from './storage.js';
import { createGraphQuery } from './queries/index.js';
import { createTraversal } from './traversal/index.js';
import { createSourceOperations } from './resolution/index.js';
import type { SourceBinding } from 'relate/connectors';
import { createMemoryStore } from './memory.js';
import { presenting } from './reads/index.js';
import { createHash } from 'node:crypto';
import { canonicalJson, validateManifest } from 'relate/model';
import type { CompiledModel } from 'relate/model';
import type {
  QueryRequest,
  ReadRequest,
  TraversalRequest,
  FullObjectResult as ReadResult,
} from '@relate/protocol';
import type { ObservationStore } from './storage.js';
import type { Principal } from './authorization/index.js';
import { createDiscovery } from './discovery.js';

export interface RuntimeOptions {
  readonly activity?: ActivityCaptureOptions;
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
}

export function createRuntime(options: RuntimeOptions) {
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

  if (
    typeof store.provenance !== 'function' ||
    (store.native && typeof store.native.provenance !== 'function')
  )
    throw new Error('Storage requires permanent object provenance');

  if (
    store.activity &&
    (!store.atomicActivity || (store.native && !store.native.atomicActivity))
  )
    throw new Error('Activity requires atomic source and native capabilities');

  const capture = createActivityCapture(
    options.graphId,
    revision,
    store.activity,
    options.activity,
  );
  const sources = Object.fromEntries(
    Object.entries(options.sources).map(([id, source]) => [id, { ...source }]),
  );

  for (const resource of manifest.sources) {
    const binding = sources[resource.id];

    if (
      !binding ||
      !binding.connectionId.trim() ||
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
    providerAccountId: sources[sourceDefinitionId]!.providerAccountId ?? null,
    partition: 'shared-service',
  });

  const nativeScope = {
    graphId: options.graphId,
    definitionRevision: revision,
  };

  async function resolveEvidence(
    target: (typeof manifest.objects)[number],
    key: string,
    maxAgeMs: number,
    canonical = false,
    transaction?: NativeTransaction,
    request: ReadRequest = {},
  ) {
    if (!target.sourceDefinitionId) {
      const record = transaction
        ? await transaction.load(target.id, key)
        : await store.native?.load(nativeScope, target.id, key);

      return record ? nativeEvidence(target, record) : undefined;
    }

    return source.resolveSourceEvidence(
      target,
      key,
      maxAgeMs,
      canonical,
      request,
    );
  }

  const source = createSourceOperations({
    capture,
    manifest,
    revision,
    store,
    sources,
    clock,
    install,
    scopeFor,
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
    principal: Principal,
    objectDefinitionId: string,
    objectId: string,
    request: ReadRequest = {},
    requiredReference?: string,
    captureAuthorization?: (check: () => Promise<boolean>) => void,
    transaction?: NativeTransaction,
  ): Promise<ReadResult> {
    const object = manifest.objects.find((o) => o.id === objectDefinitionId);

    if (object?.sourceDefinitionId)
      return source.read(
        principal,
        objectDefinitionId,
        objectId,
        request,
        requiredReference,
        captureAuthorization,
        transaction,
      );

    return native.read(
      principal,
      objectDefinitionId,
      objectId,
      request,
      transaction,
      captureAuthorization,
    );
  }

  const query = createGraphQuery({
    manifest,
    scope: nativeScope,
    store,
    clock,
    install,
    scopeFor,
    read: readObject,
    ...(options.cursorKey ? { cursorKey: options.cursorKey } : {}),
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

  const actions = createActionExecutor({
    query,
    manifest,
    scope: nativeScope,
    store,
    clock,
    timeoutMs: actionTimeoutMs,
    install,
    handlers: options.actionHandlers ?? {},
    validate: native.validate,
    read: (actor, type, id, request, transaction, captureAuthorization) =>
      readObject(
        actor,
        type,
        id,
        request,
        undefined,
        captureAuthorization,
        transaction,
      ),
  });

  const scope = (actor: Principal, supplied?: OperationScope) =>
    supplied ?? newOperationScope({ kind: 'principal', id: actor.id });
  const lineage = (type: string, record: FullObjectRecord) => {
    const object = manifest.objects.find((o) => o.id === type);
    const result = emptyObject(
      { objectDefinitionId: type, objectId: record.id },
      'returned',
    );

    return {
      ...result,
      ...Object.fromEntries(
        (['returned', 'forbidden', 'unavailable'] as const).map((kind) => [
          kind,
          (object?.properties ?? [])
            .filter((p) => {
              const status = record.meta.fields[p.name]?.status;

              return kind === 'returned'
                ? status === 'available' || status === 'absent'
                : status === kind;
            })
            .map((p) => p.id),
        ]),
      ),
    };
  };
  const describe = (type: string, result: ReadResult | FullPageResult) =>
    'status' in result
      ? {
          outcome: { status: result.status },
          objects: result.status === 'ok' ? [lineage(type, result)] : [],
          details: {},
        }
      : {
          outcome: { status: 'ok' },
          objects: result.data.map((r) => lineage(type, r)),
          details: { hasMore: !result.meta.exhausted },
        };
  const receipt = (result: ActionReceipt) => ({
    outcome:
      result.state === 'succeeded'
        ? { status: 'succeeded' }
        : { status: 'failed', code: result.error.code },
    invocationId: result.invocationId,
  });
  const activityRead = async <T>(read: () => Promise<T>): Promise<T> => {
    if (!store.activity) throw new ActivityError('unsupported');

    try {
      await install();

      return await read();
    } catch (error) {
      if (error instanceof ActivityError) throw error;

      throw new ActivityError('unavailable');
    }
  };
  const activity: ActivityReader = {
    async status() {
      if (!store.activity) return { state: 'unsupported' };

      await activityRead(() => store.activity!.status(options.graphId));

      return {
        state: 'available',
        durability: store.durability,
        operationCapture:
          options.activity?.enabled === false ? 'disabled' : 'enabled',
      };
    },
    feed: {
      read: (input) =>
        activityRead(() => store.activity!.feed.read(options.graphId, input)),
    },
    operations: {
      list: (input) =>
        activityRead(() =>
          store.activity!.operations.list(options.graphId, input),
        ),
    },
  };

  return {
    activity,
    captureDiagnostics: capture.counters,
    flushActivity: capture.flush,
    async provenance(object: ActivityObjectRef) {
      try {
        await install();
        const definition = manifest.objects.find(
          (o) => o.id === object.objectDefinitionId,
        );

        if (!definition) return undefined;

        return definition.sourceDefinitionId
          ? await store.provenance(
              scopeFor(definition.id, definition.sourceDefinitionId),
              object.objectId,
            )
          : await store.native?.provenance(nativeScope, object);
      } catch {
        throw new ActivityError('unavailable');
      }
    },
    discover: (principal: Principal) =>
      createDiscovery({ manifest, definitionRevision: revision }, principal),
    adopt(
      objectDefinitionId: string,
      sourceRecordId: string,
      supplied?: OperationScope,
    ) {
      return capture.run(
        supplied ?? newOperationScope({ kind: 'system', id: 'relate.host' }),
        'adopt',
        objectDefinitionId,
        () => source.adopt(objectDefinitionId, sourceRecordId),
        (id) => ({
          outcome: { status: 'ok' },
          target: { objectDefinitionId, objectId: id },
          objects: [
            emptyObject({ objectDefinitionId, objectId: id }, 'target'),
          ],
        }),
      );
    },
    async query(
      principal: Principal,
      objectDefinitionId: string,
      request: QueryRequest = {},
      supplied?: OperationScope,
    ) {
      return presenting(request, (r) =>
        capture.run(
          scope(principal, supplied),
          'query',
          objectDefinitionId,
          () => query(principal, objectDefinitionId, r),
          (result) => describe(objectDefinitionId, result),
        ),
      );
    },
    async read(
      principal: Principal,
      objectDefinitionId: string,
      objectId: string,
      request: ReadRequest = {},
      supplied?: OperationScope,
    ) {
      const target = { objectDefinitionId, objectId },
        objects = [emptyObject(target, 'target')];

      return presenting(request, (r) =>
        capture.run(
          scope(principal, supplied),
          'get',
          objectDefinitionId,
          () => readObject(principal, objectDefinitionId, objectId, r),
          (result) => {
            const d = describe(objectDefinitionId, result);

            return { ...d, objects: [...objects, ...d.objects] };
          },
          { target, objects },
        ),
      );
    },
    invoke(
      principal: Principal,
      actionId: string,
      request: { input: unknown; idempotencyKey: string },
      supplied?: OperationScope,
    ) {
      return capture.run(
        scope(principal, supplied),
        'invoke',
        actionId,
        () => actions.invoke(principal, actionId, request),
        receipt,
        { replayed: false },
      );
    },
    getReceipt(
      principal: Principal,
      actionId: string,
      invocationId: string,
      supplied?: OperationScope,
    ) {
      return capture.run(
        scope(principal, supplied),
        'receipt',
        actionId,
        () => actions.getReceipt(principal, actionId, invocationId),
        receipt,
      );
    },
    async traverse(
      principal: Principal,
      typeId: string,
      id: string,
      name: string,
      request: TraversalRequest = {},
      supplied?: OperationScope,
    ) {
      const relation = manifest.relationships?.find(
        (r) =>
          (r.fromObjectDefinitionId === typeId && r.forward.name === name) ||
          (r.toObjectDefinitionId === typeId && r.reverse.name === name),
      );
      const target = relation
        ? relation.fromObjectDefinitionId === typeId &&
          relation.forward.name === name
          ? relation.toObjectDefinitionId
          : relation.fromObjectDefinitionId
        : typeId;
      const from = { objectDefinitionId: typeId, objectId: id },
        objects = [emptyObject(from, 'traversal-origin')],
        details = { traversalId: relation?.id ?? name, from };

      return presenting(request, (r) =>
        capture.run(
          scope(principal, supplied),
          'traverse',
          target,
          () => traverse(principal, typeId, id, name, r),
          (result) => {
            const d = describe(target, result);

            return {
              ...d,
              objects: [...objects, ...d.objects],
              details: { ...details, ...d.details },
            };
          },
          { objects, details },
        ),
      );
    },
  };
}
