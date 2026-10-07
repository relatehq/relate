import type { Manifest } from 'relate/model';
import type { ReadRequest, ReadResult, Refresh } from '@relate/protocol';
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
import {
  boundedFetch,
  observation,
  InvalidObservation,
  SourceAccessDenied,
} from '../observations/index.js';
import type { SourceConnector } from '../observations/index.js';

/** Shared by projected data and private authorization evidence. */
export async function refreshObservation(options: {
  store: ObservationStore;
  scope: StorageScope;
  stored: StoredObject;
  object: Manifest['objects'][number];
  resource: Manifest['sources'][number];
  connector: SourceConnector;
  clock: () => number;
  request: ReadRequest;
  needsSource: boolean;
  sourcePermission: boolean;
  evidenceMaxAgeMs: number;
}) {
  const {
    store,
    scope,
    stored,
    object,
    resource,
    connector,
    clock,
    request,
    needsSource,
    sourcePermission,
    evidenceMaxAgeMs,
  } = options;
  const objectId = stored.objectId;
  const age = clock() - stored.observation.observedAt;
  const maxAge = request.maxAgeMs ?? 60_000,
    timeout = request.timeoutMs ?? 3_000;
  let refresh: Refresh = 'not-needed';
  let retention: 'confirmed' | 'failed' | 'unconfirmed' = 'confirmed';
  let ordering: 'confirmed' | 'unconfirmed' = 'confirmed';
  const warnings: Extract<ReadResult, { status: 'ok' }>['meta']['warnings'] =
    [];
  let candidate = stored;
  let permissionCandidate = stored;

  if (
    (needsSource && (request.refresh || age > maxAge || age < 0)) ||
    (sourcePermission && (request.refresh || age > evidenceMaxAgeMs || age < 0))
  ) {
    try {
      const token = await store.beginFetch(),
        observedAt = clock();
      const fetched = await boundedFetch(
        connector,
        stored.sourceRecordId,
        timeout,
        scope.providerAccountId,
      );
      const incoming = observation(
        fetched,
        resource,
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

        if (!winner) return undefined;

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

            if (!latest) return undefined;

            permissionCandidate = latest;
            const acceptance = compareObservation(latest.observation, incoming);

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

          if (ordering === 'unconfirmed') warnings.push('ordering_unconfirmed');
        }
      }
    } catch (error) {
      // Explicit provider denial is not an outage and cannot authorize fallback.
      if (error instanceof SourceAccessDenied) return undefined;

      refresh =
        error instanceof InvalidObservation || error instanceof OrderingConflict
          ? 'invalid'
          : 'unavailable';
      // A failed refresh must not restore an earlier snapshot after another
      // request retained a newer value, deletion, or permission change.
      candidate = permissionCandidate;

      try {
        const winner = await store.load(scope, objectId);

        if (!winner) return undefined;

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

  return {
    candidate,
    permissionCandidate,
    refresh,
    retention,
    ordering,
    warnings,
  };
}
