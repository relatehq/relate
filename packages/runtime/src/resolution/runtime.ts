import { createNativeOperations, nativeEvidence } from '../actions/native.js';
import { createActionExecutor } from '../actions/execute.js';
import type { ActionHandler } from '../actions/execute.js';
import type { NativeTransaction } from '../storage.js';
import { createTraversal } from './traversal.js';
import { validateReadRequest } from './request.js';
import { refreshObservation } from './refresh.js';
import { summarize } from './evidence.js';
import { createMemoryStore } from '../memory.js';
import { createHash } from 'node:crypto';
import { canonicalJson, validateManifest } from 'relate/model';
import type { CompiledModel } from 'relate/model';
import { ReadError } from '@relate/protocol';
import type {
  ReadRequest,
  ReadResult,
  FieldEvidence,
  Json,
} from '@relate/protocol';
import type {
  ObservationStore,
  StorageScope,
  StoredObject,
} from '../storage.js';
import {
  allowsField,
  conditions,
  createAuthorization,
} from '../authorization/index.js';
import type { Principal } from '../authorization/index.js';
import { boundedFetch, observation } from '../observations/index.js';
import type { SourceConnector } from '../observations/index.js';

export interface SourceBinding {
  readonly connectionId: string;
  readonly authorization: 'shared-service';
  readonly connector: SourceConnector;
}

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

    const targetScope = scopeFor(target.id, target.sourceDefinitionId);
    const retained = canonical
      ? await store.load(targetScope, key)
      : await store.resolve(targetScope, key);

    if (!retained || retained.observation.state !== 'present') return undefined;

    const resolved = await refreshObservation({
      store,
      scope: targetScope,
      stored: retained,
      object: target,
      resource: manifest.sources.find(
        (s) => s.id === target.sourceDefinitionId,
      )!,
      connector: sources[target.sourceDefinitionId]!.connector,
      clock,
      request: { ...request, maxAgeMs, select: [] },
      needsSource: true,
      sourcePermission: true,
      evidenceMaxAgeMs: maxAgeMs,
    });

    return resolved?.candidate.observation.state === 'present' &&
      resolved.permissionCandidate.observation.state === 'present'
      ? resolved
      : undefined;
  }

  const native = createNativeOperations({
    manifest,
    scope: nativeScope,
    store,
    clock,
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
    validateReadRequest(request);
    const maxAge = request.maxAgeMs ?? 60_000;

    const object = manifest.objects.find((o) => o.id === objectDefinitionId);
    const policy = Object.hasOwn(manifest.policies, objectDefinitionId)
      ? manifest.policies[objectDefinitionId]
      : undefined;

    if (!object || !policy || !principal.roles.includes(policy.read.role))
      return { status: 'not-found' };

    await install();

    if (!object.sourceDefinitionId)
      return native.read(
        principal,
        object,
        objectId,
        request,
        transaction,
        captureAuthorization,
      );

    const sourceDefinitionId = object.sourceDefinitionId;
    const scope = scopeFor(objectDefinitionId, sourceDefinitionId);
    let stored: StoredObject | undefined;

    try {
      stored = await store.load(scope, objectId);
    } catch {
      throw new ReadError('unavailable');
    }

    if (!stored || stored.observation.state === 'deleted')
      return { status: 'not-found' };

    const select = [
      ...new Set([
        ...(request.select ??
          object.properties
            .filter((p) => allowsField(principal, policy, p.access))
            .map((p) => p.name)),
        ...(requiredReference ? [requiredReference] : []),
      ]),
    ];
    const visible = object.properties.filter(
      (p) =>
        select.includes(p.name) && allowsField(principal, policy, p.access),
    );
    const needsSource = visible.some(
      (p) => p.origin.kind === 'source' || p.origin.kind === 'reference',
    );
    const sourcePermission =
      conditions(policy).some((condition) =>
        object.properties.some(
          (p) => p.id === condition.path[0] && p.origin.kind !== 'object-id',
        ),
      ) || visible.some((p) => p.origin.kind === 'reference');
    const resolved = await refreshObservation({
      store,
      scope,
      stored,
      object,
      resource: manifest.sources.find(
        (s) => s.id === object.sourceDefinitionId,
      )!,
      connector: sources[sourceDefinitionId]!.connector,
      clock,
      request,
      needsSource,
      sourcePermission,
      evidenceMaxAgeMs: policy.read.where
        ? policy.read.evidenceMaxAgeMs
        : 60_000,
    });

    if (!resolved) return { status: 'not-found' };

    const { candidate, refresh, retention, ordering, warnings } = resolved;

    const evidence = createAuthorization({
      manifest,
      principal,
      clock,
      resolve: (target, key, maxAgeMs, canonical = false) =>
        resolveEvidence(target, key, maxAgeMs, canonical, transaction, request),
    });

    if (!(await evidence.allows(object, resolved)))
      return { status: 'not-found' };

    const data: Record<string, Json> = {},
      fields: Record<string, FieldEvidence> = {};

    for (const name of select) {
      const property = visible.find((p) => p.name === name);

      if (!property) {
        // Role membership alone decides `forbidden`; unknown names stay unavailable.
        fields[name] = {
          status: object.properties.some((p) => p.name === name)
            ? 'forbidden'
            : 'unavailable',
        };
        continue;
      }

      const native = property.origin.kind === 'object-id';
      const stale =
        !native &&
        (clock() < candidate.observation.observedAt ||
          clock() - candidate.observation.observedAt > maxAge);

      if (stale && request.stale === 'omit') {
        fields[name] = { status: 'unavailable' };
        continue;
      }

      let value = native
        ? candidate.objectId
        : candidate.observation.values[name];

      if (property.origin.kind === 'reference') {
        value = await evidence.reference(object, resolved, property);

        if (value === undefined) {
          fields[name] = { status: 'unavailable' };
          continue;
        }
      }

      if (value !== undefined) data[name] = value;

      fields[name] = {
        status: value === undefined ? 'absent' : 'available',
        freshness: stale ? 'stale' : 'fresh',
        observedAt: new Date(candidate.observation.observedAt).toISOString(),
        source: native ? 'native' : 'source',
        ...(!native
          ? {
              sourceDefinitionId,
              orderingBasis: candidate.observation.version
                ? ('source-version' as const)
                : ('fetch-start' as const),
            }
          : {}),
        retention: native ? 'confirmed' : retention,
        retentionDurability: store.durability,
        ordering: native ? 'confirmed' : ordering,
        refresh: native ? 'not-needed' : refresh,
      };
    }

    // Related-source I/O may outlast an evidence window; recheck before disclosure.
    if (!(await evidence.allows(object, resolved)))
      return { status: 'not-found' };

    const summary = summarize(fields, warnings);

    if (summary.completeness === 'partial' && request.requireComplete)
      throw new ReadError('incomplete');

    captureAuthorization?.(async () => {
      if (!(await evidence.allows(object, resolved))) return false;

      for (const property of visible) {
        if (
          property.origin.kind === 'reference' &&
          Object.hasOwn(data, property.name) &&
          (await evidence.reference(object, resolved, property)) !==
            data[property.name]
        )
          return false;
      }

      return true;
    });

    return {
      status: 'ok',
      data,
      meta: {
        ...summary,
        definitionRevision: revision,
        fields,
        warnings,
      },
    };
  }

  const runtime = {
    /** Trusted host ingestion operation. Ordinary reads cannot establish membership. */
    async adopt(
      objectDefinitionId: string,
      sourceRecordId: string,
    ): Promise<string> {
      const object = manifest.objects.find((o) => o.id === objectDefinitionId);

      if (!object?.sourceDefinitionId || !sourceRecordId.trim())
        throw new Error('Invalid adoption target');

      await install();
      const token = await store.beginFetch(),
        observedAt = clock();
      const fetched = await boundedFetch(
        sources[object.sourceDefinitionId]!.connector,
        sourceRecordId,
        3_000,
      );
      const incoming = observation(
        fetched,
        manifest.sources.find((s) => s.id === object.sourceDefinitionId)!,
        object,
        sourceRecordId,
        token,
        observedAt,
      );

      if (incoming.state === 'deleted')
        throw new Error('Cannot adopt a deleted source record');

      return (
        await store.accept(
          scopeFor(objectDefinitionId, object.sourceDefinitionId),
          {
            sourceRecordId,
            adopt: true,
            observation: incoming,
          },
        )
      ).object.objectId;
    },
    read(
      principal: Principal,
      objectDefinitionId: string,
      objectId: string,
      request: ReadRequest = {},
    ) {
      return readObject(principal, objectDefinitionId, objectId, request);
    },
  };

  return {
    ...runtime,
    invoke: createActionExecutor({
      manifest,
      scope: nativeScope,
      store,
      clock,
      timeoutMs: actionTimeoutMs,
      install,
      handlers: options.actionHandlers ?? {},
      validate: native.validate,
      read: (actor, type, id, request, transaction) =>
        readObject(actor, type, id, request, undefined, undefined, transaction),
    }),
    traverse: createTraversal({
      manifest,
      graphId: options.graphId,
      revision,
      store,
      clock,
      scopeFor,
      read: readObject,
      ...(options.cursorKey ? { cursorKey: options.cursorKey } : {}),
    }),
  };
}
