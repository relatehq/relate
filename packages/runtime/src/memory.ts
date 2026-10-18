import { createMemoryActivity, acceptedFeed } from './activity/index.js';
import type { ActivityLimits } from './activity/index.js';
import { randomUUID } from 'node:crypto';
import { canonicalJson } from 'relate/model';
import type {
  ObservationStore,
  StorageScope,
  StoredObject,
} from './storage.js';
import { createNativeMemoryStore } from './native-memory.js';
import {
  RetentionError,
  compareObjectIds,
  describeAcceptedChange,
} from './storage.js';
import { compareObservation } from './observations/ordering.js';

/** Isolated, process-local retention. Reuse the instance to share state between runtimes. */
export function createMemoryStore(
  limits: ActivityLimits = {},
): ObservationStore {
  const activity = createMemoryActivity(limits);
  const graphs = new Map<string, string>();
  const scopes = new Map<string, Map<string, StoredObject>>();
  let token = 0n;
  const scopeKey = (scope: StorageScope) => canonicalJson(scope);

  return {
    durability: 'volatile',
    activity: activity.store,
    atomicActivity: true,
    async provenance(scope, objectId) {
      const object = await this.load(scope, objectId);

      return object ? (object.provenance ?? { kind: 'unknown' }) : undefined;
    },
    native: createNativeMemoryStore(
      (scope) => graphs.get(scope.graphId) === scope.definitionRevision,
      activity.publish,
    ),
    async install(graphId, definitionRevision) {
      const installed = graphs.get(graphId);

      if (installed !== undefined && installed !== definitionRevision)
        throw new Error('Installed model differs; explicit migration required');

      graphs.set(graphId, definitionRevision);
    },
    async beginFetch() {
      return String(++token);
    },
    async load(scope, objectId) {
      if (graphs.get(scope.graphId) !== scope.definitionRevision)
        return undefined;

      const object = [...(scopes.get(scopeKey(scope))?.values() ?? [])].find(
        (candidate) => candidate.objectId === objectId,
      );

      return object && structuredClone(object);
    },
    async resolve(scope, sourceRecordId) {
      if (graphs.get(scope.graphId) !== scope.definitionRevision)
        return undefined;

      const object = scopes.get(scopeKey(scope))?.get(sourceRecordId);

      return object && structuredClone(object);
    },
    async scan(scope, { after, limit }) {
      if (!Number.isInteger(limit) || limit < 1 || limit > 100)
        throw new Error('Invalid scan limit');

      if (graphs.get(scope.graphId) !== scope.definitionRevision)
        return { objects: [], hasMore: false };

      const candidates = [...(scopes.get(scopeKey(scope))?.values() ?? [])]
        .filter((o) => !after || compareObjectIds(o.objectId, after) > 0)
        .sort((a, b) => compareObjectIds(a.objectId, b.objectId))
        .slice(0, limit + 1);

      return {
        objects: structuredClone(candidates.slice(0, limit)),
        hasMore: candidates.length > limit,
      };
    },
    async accept(scope, input) {
      // No await in this operation: compare and replace are atomic within this store.
      if (graphs.get(scope.graphId) !== scope.definitionRevision)
        throw new RetentionError('failed', {
          cause: new Error('Model is not installed'),
        });

      const key = scopeKey(scope);
      const objects = scopes.get(key) ?? new Map<string, StoredObject>();
      const previous = objects.get(input.sourceRecordId);

      if (
        (!previous && !input.adopt) ||
        (input.objectId !== undefined && previous?.objectId !== input.objectId)
      )
        throw new RetentionError('failed', {
          cause: new Error('Membership/alias mismatch'),
        });

      const acceptance = compareObservation(
        previous?.observation,
        input.observation,
      );
      const object =
        acceptance === 'changed' || acceptance === 'unchanged'
          ? structuredClone({
              objectId: previous?.objectId ?? randomUUID(),
              sourceRecordId: input.sourceRecordId,
              observation: input.observation,
              provenance:
                previous?.provenance ??
                (input.provenance
                  ? {
                      kind: 'adopted' as const,
                      actor: input.provenance.actor,
                      at: input.provenance.occurredAt,
                      sourceDefinitionId: scope.sourceDefinitionId,
                    }
                  : { kind: 'unknown' as const }),
            })
          : previous!;
      // Prepare the returned snapshot before mutating retained state.
      const change =
        acceptance === 'changed' || acceptance === 'unchanged'
          ? describeAcceptedChange(previous?.observation, input.observation)
          : undefined;
      const result = {
        object: structuredClone(object),
        acceptance,
        ...(change ? { change } : {}),
      };

      if (acceptance === 'changed' || acceptance === 'unchanged') {
        const draft = acceptedFeed(
          scope,
          object.objectId,
          previous?.observation,
          input.observation,
          input.provenance,
        );

        if (draft) {
          try {
            activity.publish(scope.graphId, [draft]);
          } catch (error) {
            throw new RetentionError('failed', { cause: error });
          }
        }
      }

      objects.set(input.sourceRecordId, object);
      scopes.set(key, objects);

      return result;
    },
  };
}
