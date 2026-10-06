import { createMemoryStore } from '../memory.js';
import { createHash } from 'node:crypto';
import { canonicalJson, validateManifest } from 'relate/model';
import type { CompiledModel } from 'relate/model';
import { ReadError } from '@relate/protocol';
import type {
  ReadRequest,
  ReadResult,
  Refresh,
  FieldEvidence,
  Json,
} from '@relate/protocol';
import type {
  ObservationStore,
  StorageScope,
  StoredObject,
} from '../storage.js';
import {
  compareObservation,
  OrderingConflict,
  RetentionError,
} from '../storage.js';
import { allowsField, allowsObject } from '../authorization/index.js';
import type { Principal } from '../authorization/index.js';
import {
  boundedFetch,
  observation,
  InvalidObservation,
} from '../observations/index.js';
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
}

export function createRuntime(options: RuntimeOptions) {
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

  return {
    /** Trusted host ingestion operation. Ordinary reads cannot establish membership. */
    async adopt(
      objectDefinitionId: string,
      sourceRecordId: string,
    ): Promise<string> {
      const object = manifest.objects.find((o) => o.id === objectDefinitionId);

      if (!object || !sourceRecordId.trim())
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
    async read(
      principal: Principal,
      objectDefinitionId: string,
      objectId: string,
      request: ReadRequest = {},
    ): Promise<ReadResult> {
      const maxAge = request.maxAgeMs ?? 60_000,
        timeout = request.timeoutMs ?? 3_000;

      if (
        !Number.isFinite(maxAge) ||
        maxAge < 0 ||
        !Number.isFinite(timeout) ||
        timeout <= 0 ||
        timeout > 10_000 ||
        (request.stale !== undefined &&
          !['allow', 'omit'].includes(request.stale)) ||
        (request.select !== undefined &&
          (!Array.isArray(request.select) ||
            request.select.length > 100 ||
            request.select.some(
              (p) =>
                typeof p !== 'string' ||
                ['__proto__', 'constructor', 'prototype'].includes(p),
            ))) ||
        (request.refresh !== undefined &&
          typeof request.refresh !== 'boolean') ||
        (request.requireComplete !== undefined &&
          typeof request.requireComplete !== 'boolean')
      )
        throw new ReadError('invalid-request');

      const object = manifest.objects.find((o) => o.id === objectDefinitionId);
      const policy = Object.hasOwn(manifest.policies, objectDefinitionId)
        ? manifest.policies[objectDefinitionId]
        : undefined;

      if (!object || !policy || !principal.roles.includes(policy.read.role))
        return { status: 'not-found' };

      await install();
      const scope = scopeFor(objectDefinitionId, object.sourceDefinitionId);
      let stored: StoredObject | undefined;

      try {
        stored = await store.load(scope, objectId);
      } catch {
        throw new ReadError('unavailable');
      }

      if (!stored || stored.observation.state === 'deleted')
        return { status: 'not-found' };

      const select = [
        ...new Set(
          request.select ??
            object.properties
              .filter((p) => allowsField(principal, policy, p.access))
              .map((p) => p.name),
        ),
      ];
      const visible = object.properties.filter(
        (p) =>
          select.includes(p.name) && allowsField(principal, policy, p.access),
      );
      const needsSource = visible.some((p) => p.origin.kind === 'source');
      const dependency = object.properties.find(
        (p) => p.id === policy.read.where?.propertyDefinitionId,
      );
      const sourcePermission = dependency?.origin.kind === 'source';
      const age = clock() - stored.observation.observedAt;
      let refresh: Refresh = 'not-needed';
      let retention: 'confirmed' | 'failed' | 'unconfirmed' = 'confirmed';
      let ordering: 'confirmed' | 'unconfirmed' = 'confirmed';
      const warnings: Extract<
        ReadResult,
        { status: 'ok' }
      >['meta']['warnings'] = [];
      let candidate = stored;
      let permissionCandidate = stored;

      if (
        (needsSource && (request.refresh || age > maxAge || age < 0)) ||
        (sourcePermission &&
          (request.refresh || age > policy.read.evidenceMaxAgeMs || age < 0))
      ) {
        try {
          const token = await store.beginFetch(),
            observedAt = clock();
          const fetched = await boundedFetch(
            sources[object.sourceDefinitionId]!.connector,
            stored.sourceRecordId,
            timeout,
          );
          const incoming = observation(
            fetched,
            manifest.sources.find((s) => s.id === object.sourceDefinitionId)!,
            object,
            stored.sourceRecordId,
            token,
            observedAt,
          );
          // Even when retention fails, a confirmed deletion cannot return old data.
          const known = compareObservation(stored.observation, incoming);

          if (known === 'superseded' || known === 'replay') {
            // Re-read the winner because another process may have advanced it further.
            const winner = await store.load(scope, objectId);

            if (!winner) return { status: 'not-found' };

            candidate = winner;
            permissionCandidate = candidate;
            refresh = 'superseded';
          } else {
            refresh = 'succeeded';

            try {
              candidate = (
                await store.accept(scope, {
                  sourceRecordId: stored.sourceRecordId,
                  objectId,
                  adopt: false,
                  observation: incoming,
                })
              ).object;
              permissionCandidate = candidate;

              if (candidate.observation.token !== incoming.token)
                refresh = 'superseded';
            } catch (error) {
              if (error instanceof OrderingConflict) throw error;

              retention =
                error instanceof RetentionError ? error.outcome : 'unconfirmed';
              candidate = { ...stored, observation: incoming };

              try {
                const latest = await store.load(scope, objectId);

                if (!latest) return { status: 'not-found' };

                permissionCandidate = latest;
                const acceptance = compareObservation(
                  latest.observation,
                  incoming,
                );

                if (acceptance === 'superseded' || acceptance === 'replay') {
                  candidate = latest;
                  retention = 'confirmed';
                  refresh =
                    acceptance === 'superseded' ? 'superseded' : 'succeeded';
                }
              } catch (checkError) {
                if (checkError instanceof OrderingConflict) throw checkError;

                ordering = 'unconfirmed';
              }

              if (retention !== 'confirmed')
                warnings.push(
                  retention === 'failed'
                    ? 'observation_not_retained'
                    : 'retention_unconfirmed',
                );

              if (ordering === 'unconfirmed')
                warnings.push('ordering_unconfirmed');
            }
          }
        } catch (error) {
          refresh =
            error instanceof InvalidObservation ||
            error instanceof OrderingConflict
              ? 'invalid'
              : 'unavailable';
          // A failed refresh must not restore an earlier snapshot after another
          // request retained a newer value, deletion, or permission change.
          candidate = permissionCandidate;

          try {
            const winner = await store.load(scope, objectId);

            if (!winner) return { status: 'not-found' };

            candidate = winner;
          } catch {
            // Preserve the latest known durable snapshot; freshness still applies.
          }

          permissionCandidate = candidate;
          retention = 'confirmed';
          ordering = 'confirmed';
          warnings.length = 0;
        }
      }

      if (
        candidate.observation.state === 'deleted' ||
        !allowsObject(
          principal,
          policy,
          object,
          permissionCandidate,
          clock(),
          manifest.claims,
        )
      )
        return { status: 'not-found' };

      // A transient result may revoke access but may never establish fresh permission.
      if (
        !allowsObject(
          principal,
          policy,
          object,
          candidate,
          clock(),
          manifest.claims,
        )
      )
        return { status: 'not-found' };

      const data: Record<string, Json> = {},
        fields: Record<string, FieldEvidence> = {};

      for (const name of select) {
        const property = visible.find((p) => p.name === name);

        if (!property) {
          fields[name] = { status: 'unavailable' };
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

        const value = native
          ? candidate.objectId
          : candidate.observation.values[name];

        if (value !== undefined) data[name] = value;

        fields[name] = {
          status: value === undefined ? 'absent' : 'available',
          freshness: stale ? 'stale' : 'fresh',
          observedAt: new Date(candidate.observation.observedAt).toISOString(),
          source: native ? 'native' : 'source',
          ...(!native
            ? {
                sourceDefinitionId: object.sourceDefinitionId,
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

      const complete = Object.values(fields).every(
        (f) => f.status !== 'unavailable',
      );

      if (!complete && request.requireComplete)
        throw new ReadError('incomplete');

      return {
        status: 'ok',
        data,
        meta: {
          completeness: complete ? 'complete' : 'partial',
          definitionRevision: revision,
          degraded:
            !complete ||
            warnings.length > 0 ||
            Object.values(fields).some(
              (f) =>
                f.status !== 'unavailable' &&
                (f.freshness === 'stale' ||
                  f.refresh === 'invalid' ||
                  f.refresh === 'unavailable'),
            ),
          fields,
          warnings,
        },
      };
    },
  };
}
