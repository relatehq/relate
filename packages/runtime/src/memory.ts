import { randomUUID } from 'node:crypto';
import { canonicalJson } from 'relate/model';
import type {
  ObservationStore,
  StorageScope,
  StoredObject,
} from './storage.js';
import { RetentionError } from './storage.js';
import { compareObservation } from './observations/ordering.js';

/** Isolated, process-local retention. Reuse the instance to share state between runtimes. */
export function createMemoryStore(): ObservationStore {
  const graphs = new Map<string, string>();
  const scopes = new Map<string, Map<string, StoredObject>>();
  let token = 0n;
  const scopeKey = (scope: StorageScope) => canonicalJson(scope);

  return {
    durability: 'volatile',
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
            })
          : previous!;
      // Prepare the returned snapshot before mutating retained state.
      const result = { object: structuredClone(object), acceptance };

      objects.set(input.sourceRecordId, object);
      scopes.set(key, objects);

      return result;
    },
  };
}
