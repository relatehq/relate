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

  return {
    discover: (principal: Principal) =>
      createDiscovery({ manifest, definitionRevision: revision }, principal),
    adopt: source.adopt,
    async query(
      principal: Principal,
      objectDefinitionId: string,
      request: QueryRequest = {},
    ) {
      return presenting(request, (r) =>
        query(principal, objectDefinitionId, r),
      );
    },
    async read(
      principal: Principal,
      objectDefinitionId: string,
      objectId: string,
      request: ReadRequest = {},
    ) {
      return presenting(request, (r) =>
        readObject(principal, objectDefinitionId, objectId, r),
      );
    },
    ...createActionExecutor({
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
    }),
    async traverse(
      principal: Principal,
      typeId: string,
      id: string,
      name: string,
      request: TraversalRequest = {},
    ) {
      return presenting(request, (r) =>
        traverse(principal, typeId, id, name, r),
      );
    },
  };
}
