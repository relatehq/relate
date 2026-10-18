import type { Manifest } from 'relate/model';
import type {
  ReadRequest,
  FullReadResult as ReadResult,
  Refresh,
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
import {
  boundedFetch,
  observation,
  InvalidObservation,
  SourceAccessDenied,
} from '../observations/index.js';
import type { AnySourceConnector } from 'relate/connectors';
import {
  activeOperation,
  createOperationScope,
  nestedScope,
  referenceEntry,
  runtimeActor,
  uuidv7,
} from '../activity/index.js';
import type { Capture, OperationBody } from '../activity/index.js';

type RefreshBody = Extract<OperationBody, { kind: 'refresh' }>;

type RefreshOutcome = Pick<RefreshBody, 'outcome' | 'details'>;

/** Shared by projected data and private authorization evidence. */
export async function refreshObservation(options: {
  store: ObservationStore;
  scope: StorageScope;
  stored: StoredObject;
  object: Manifest['objects'][number];
  resource: Manifest['sources'][number];
  connector: AnySourceConnector;
  clock: () => number;
  request: ReadRequest;
  needsSource: boolean;
  sourcePermission: boolean;
  evidenceMaxAgeMs: number;
  capture: Capture;
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
  // A revision bump cannot migrate persisted name-keyed values. Check before
  // refresh or policy evaluation can hide the incompatible installation.
  const assertPropertyIds = (snapshot: StoredObject) => {
    if (
      Object.keys(snapshot.observation.values).some(
        (key) => !object.properties.some((property) => property.id === key),
      )
    )
      throw new Error(
        'Stored observation values must use property IDs; explicit migration required',
      );
  };

  assertPropertyIds(stored);
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
    // Each fetch attempt is a nested operation of the enclosing attempt, with
    // its own outcome; a fresh observation that needs no fetch records none.
    // Work outside any consumer or host call (none today) is the runtime's
    // own top-level refresh rather than a child of an invented parent.
    const parent = activeOperation()?.scope;
    const attempt = parent
      ? nestedScope(parent)
      : createOperationScope(runtimeActor);
    const started = { at: Date.now(), monotonic: performance.now() };
    let settled: RefreshOutcome = {
      outcome: { status: 'rejected', code: 'internal' },
      details: {},
    };
    const ok = (result: 'changed' | 'unchanged' | 'superseded') => {
      settled = { outcome: { status: 'ok' }, details: { refresh: result } };
    };

    // Recorded on every path, including early returns, once the attempt settles.
    try {
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
          // A competing observation won, whatever the re-read below finds.
          ok('superseded');

          // Re-read the winner because another process may have advanced it further.
          const winner = await store.load(scope, objectId);

          if (!winner) return undefined;

          candidate = winner;
          permissionCandidate = candidate;
          refresh = 'superseded';
        } else {
          refresh = 'succeeded';

          try {
            const accepted = await store.accept(scope, {
              sourceRecordId: stored.sourceRecordId,
              objectId,
              adopt: false,
              observation: incoming,
              attribution: {
                changeId: uuidv7(),
                operationId: attempt.id,
                ...(parent ? { parentOperationId: parent.id } : {}),
                actor: attempt.actor,
                context: attempt.context,
                occurredAt: observedAt,
              },
            });

            candidate = accepted.object;
            permissionCandidate = candidate;

            if (candidate.observation.token !== incoming.token)
              refresh = 'superseded';

            // The adapter's locked classification, not Acceptance or a local diff.
            ok(
              accepted.change
                ? 'changed'
                : accepted.acceptance === 'changed' ||
                    accepted.acceptance === 'unchanged'
                  ? 'unchanged'
                  : 'superseded',
            );
          } catch (error) {
            if (error instanceof OrderingConflict) throw error;

            retention =
              error instanceof RetentionError ? error.outcome : 'unconfirmed';
            // A known rollback is a sanitized rejection; anything else may have committed.
            settled =
              retention === 'failed'
                ? {
                    outcome: { status: 'rejected', code: 'unavailable' },
                    details: {},
                  }
                : { outcome: { status: 'uncertain' }, details: {} };
            candidate = { ...stored, observation: incoming };

            try {
              const latest = await store.load(scope, objectId);

              if (!latest) return undefined;

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
        settled = {
          outcome: {
            status: 'rejected',
            code:
              error instanceof SourceAccessDenied
                ? 'denied'
                : error instanceof InvalidObservation ||
                    error instanceof OrderingConflict
                  ? 'invalid'
                  : 'unavailable',
          },
          details: {},
        };

        // Explicit provider denial is not an outage and cannot authorize fallback.
        if (error instanceof SourceAccessDenied) return undefined;

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
    } finally {
      options.capture.record(attempt, started, {
        kind: 'refresh',
        definitionId: object.id,
        target: { objectDefinitionId: object.id, objectId },
        objects: [
          referenceEntry({ objectDefinitionId: object.id, objectId }, 'target'),
        ],
        ...settled,
      } as RefreshBody);
    }
  }

  assertPropertyIds(candidate);
  assertPropertyIds(permissionCandidate);

  return {
    candidate,
    permissionCandidate,
    refresh,
    retention,
    ordering,
    warnings,
  };
}
