import type { Manifest } from 'relate/model';
import { ReadError } from '@relate/protocol';
import type {
  ReadRequest,
  FullReadResult as ReadResult,
  FieldEvidence,
  Json,
} from '@relate/protocol';
import type {
  ObservationStore,
  StorageScope,
  StoredObject,
  NativeTransaction,
} from '../storage.js';
import {
  allowsField,
  conditions,
  createAuthorization,
} from '../authorization/index.js';
import type {
  Principal,
  AuthorizationEvidence,
} from '../authorization/index.js';
import {
  boundedFetch,
  observation,
  verifyAccount,
  SourceAccessDenied,
} from '../observations/index.js';
import type { SourceBinding } from 'relate/connectors';
import { validateReadRequest, summarize } from '../reads/index.js';
import { refreshObservation } from './refresh.js';

/** Source operations receive cross-object evidence resolution from composition. */
export function createSourceOperations(options: {
  manifest: Manifest;
  revision: string;
  store: ObservationStore;
  sources: Readonly<Record<string, SourceBinding>>;
  clock(): number;
  install(): Promise<void>;
  scopeFor(objectId: string, sourceId: string): StorageScope;
  resolve(
    target: Manifest['objects'][number],
    key: string,
    maxAgeMs: number,
    canonical: boolean,
    transaction?: NativeTransaction,
    request?: ReadRequest,
  ): Promise<AuthorizationEvidence | undefined>;
}) {
  const { manifest, revision, store, sources, clock, install, scopeFor } =
    options;

  async function accountAllowed(sourceId: string, request: ReadRequest = {}) {
    const binding = sources[sourceId]!;

    try {
      await verifyAccount(
        binding.connector,
        binding.providerAccountId ?? null,
        request.timeoutMs ?? 3_000,
      );

      return true;
    } catch (error) {
      if (error instanceof SourceAccessDenied) return false;

      throw new ReadError('unavailable');
    }
  }

  async function resolveSourceEvidence(
    target: Manifest['objects'][number],
    key: string,
    maxAgeMs: number,
    canonical = false,
    request: ReadRequest = {},
  ) {
    if (!target.sourceDefinitionId)
      throw new Error(
        'Source evidence resolution requires a source-backed object',
      );

    const targetScope = scopeFor(target.id, target.sourceDefinitionId);
    const retained = canonical
      ? await store.load(targetScope, key)
      : await store.resolve(targetScope, key);

    if (!retained || retained.observation.state !== 'present') return undefined;

    if (!(await accountAllowed(target.sourceDefinitionId, request)))
      return undefined;

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

    if (!(await accountAllowed(target.sourceDefinitionId, request)))
      return undefined;

    return resolved?.candidate.observation.state === 'present' &&
      resolved.permissionCandidate.observation.state === 'present'
      ? resolved
      : undefined;
  }

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

    if (
      !object?.sourceDefinitionId ||
      !policy ||
      !principal.roles.includes(policy.read.role)
    )
      return { status: 'not-found' };

    await install();

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

    if (!(await accountAllowed(sourceDefinitionId, request)))
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
        options.resolve(target, key, maxAgeMs, canonical, transaction, request),
    });

    if (!(await evidence.allows(object, resolved)))
      return { status: 'not-found' };

    const data: Record<string, Json> = {},
      fields: Record<string, FieldEvidence> = {};

    for (const name of select) {
      const property = object.properties.find((p) => p.name === name);

      if (!property) {
        fields[name] = { status: 'unavailable' };
        continue;
      }

      if (!allowsField(principal, policy, property.access)) {
        fields[name] = { status: 'forbidden' };
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
        : candidate.observation.values[property.id];

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

    if (!(await accountAllowed(sourceDefinitionId, request)))
      return { status: 'not-found' };

    // Source and identity I/O may outlast an evidence window; recheck before disclosure.
    if (!(await evidence.allows(object, resolved)))
      return { status: 'not-found' };

    const summary = summarize(fields, warnings);

    if (summary.completeness === 'partial' && request.requireComplete)
      throw new ReadError('incomplete');

    captureAuthorization?.(async () => {
      if (!(await accountAllowed(sourceDefinitionId, request))) return false;

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
        evidence: 'full',
        ...summary,
        definitionRevision: revision,
        fields,
        warnings,
      },
    };
  }

  return {
    resolveSourceEvidence,
    /** Trusted host ingestion operation. Ordinary reads cannot establish membership. */
    async adopt(
      objectDefinitionId: string,
      sourceRecordId: string,
    ): Promise<string> {
      const object = manifest.objects.find((o) => o.id === objectDefinitionId);

      if (!object?.sourceDefinitionId || !sourceRecordId.trim())
        throw new Error('Invalid adoption target');

      await install();

      if (!(await accountAllowed(object.sourceDefinitionId)))
        throw new SourceAccessDenied();

      const token = await store.beginFetch(),
        observedAt = clock();
      const fetched = await boundedFetch(
        sources[object.sourceDefinitionId]!.connector,
        sourceRecordId,
        3_000,
        sources[object.sourceDefinitionId]!.providerAccountId ?? null,
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
    read: readObject,
  };
}
