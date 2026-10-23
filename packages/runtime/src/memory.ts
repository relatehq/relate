import { randomUUID } from 'node:crypto';
import { canonicalJson } from 'relate/model';
import type { OperationActor } from '@relate/protocol';
import type {
  ObservationStore,
  StorageScope,
  StoredObject,
} from './storage.js';
import { createNativeMemoryStore } from './native-memory.js';
import {
  RetentionError,
  compareObjectIds,
  sourceChangeDraft,
} from './storage.js';
import { startAfter } from './memory-order.js';
import { compareObservation } from './observations/ordering.js';
import { describeAcceptedChange } from './observations/changes.js';
import { createMemoryActivity } from './memory-activity.js';
import type { MemoryActivityLimits } from './memory-activity.js';

export interface MemoryStoreOptions {
  /**
   * Bounded volatile activity retention, enabled by default. `false` omits the
   * activity capability; object provenance is still recorded.
   */
  readonly activity?: false | MemoryActivityLimits;
}

/** One scope's adopted objects, indexed for each lookup the store serves. */
interface Population {
  readonly bySource: Map<string, StoredObject>;
  readonly byObject: Map<string, StoredObject>;
  /**
   * Adopted object IDs; identities are never removed. Adoption appends and the
   * next scan sorts, so bulk adoption stays linear instead of shifting a
   * sorted array once per random ID.
   */
  readonly order: string[];
  sorted: boolean;
}

/** Isolated, process-local retention. Reuse the instance to share state between runtimes. */
export function createMemoryStore(
  options: MemoryStoreOptions = {},
): ObservationStore {
  const graphs = new Map<string, string>();
  const scopes = new Map<string, Population>();
  // Adoption provenance lives with the identity, never with activity retention.
  const adoptions = new Map<string, { actor: OperationActor; at: number }>();
  let token = 0n;
  const scopeKey = (scope: StorageScope) => canonicalJson(scope);
  const activity =
    options.activity === false
      ? undefined
      : createMemoryActivity(options.activity);
  const installed = (scope: { graphId: string; definitionRevision: string }) =>
    graphs.get(scope.graphId) === scope.definitionRevision;
  const find = (scope: StorageScope, objectId: string) =>
    scopes.get(scopeKey(scope))?.byObject.get(objectId);

  return {
    durability: 'volatile',
    native: createNativeMemoryStore(installed, activity?.prepareFeed),
    ...(activity ? { activity: activity.store } : {}),
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
      if (!installed(scope)) return undefined;

      const object = find(scope, objectId);

      return object && structuredClone(object);
    },
    async loadMany(scope, objectIds) {
      if (objectIds.length > 100) throw new Error('Invalid load batch');

      const objects = new Map<string, StoredObject>();

      if (!installed(scope)) return objects;

      for (const objectId of objectIds) {
        const object = find(scope, objectId);

        if (object) objects.set(objectId, structuredClone(object));
      }

      return objects;
    },
    async provenance(scope, objectId) {
      if (!installed(scope) || !find(scope, objectId)) return undefined;

      const adoption = adoptions.get(
        canonicalJson([scopeKey(scope), objectId]),
      );

      return adoption
        ? {
            kind: 'adopted',
            actor: structuredClone(adoption.actor),
            at: new Date(adoption.at).toISOString(),
            sourceDefinitionId: scope.sourceDefinitionId,
          }
        : { kind: 'unknown' };
    },
    async resolve(scope, sourceRecordId) {
      if (graphs.get(scope.graphId) !== scope.definitionRevision)
        return undefined;

      const object = scopes.get(scopeKey(scope))?.bySource.get(sourceRecordId);

      return object && structuredClone(object);
    },
    async scan(scope, { after, limit }) {
      if (!Number.isInteger(limit) || limit < 1 || limit > 100)
        throw new Error('Invalid scan limit');

      if (graphs.get(scope.graphId) !== scope.definitionRevision)
        return { objects: [], hasMore: false };

      const population = scopes.get(scopeKey(scope));

      if (!population) return { objects: [], hasMore: false };

      if (!population.sorted) {
        population.order.sort(compareObjectIds);
        population.sorted = true;
      }

      const start = startAfter(
        population.order,
        after || undefined,
        (objectId) => objectId,
      );
      const candidates = population.order
        .slice(start, start + limit + 1)
        .map((objectId) => population.byObject.get(objectId)!);

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
      const population = scopes.get(key) ?? {
        bySource: new Map<string, StoredObject>(),
        byObject: new Map<string, StoredObject>(),
        order: [],
        sorted: true,
      };
      const previous = population.bySource.get(input.sourceRecordId);

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
      const winning = acceptance === 'changed' || acceptance === 'unchanged';
      const object = winning
        ? structuredClone({
            objectId: previous?.objectId ?? randomUUID(),
            sourceRecordId: input.sourceRecordId,
            observation: input.observation,
          })
        : previous!;
      const transition = winning
        ? describeAcceptedChange(previous?.observation, input.observation)
        : undefined;
      const change = transition && {
        id: input.attribution.changeId,
        ...transition,
      };
      let publish = () => {};

      // Size and validate the change before mutating anything: a change the
      // feed cannot hold rejects the whole acceptance.
      try {
        if (change && activity)
          publish = activity.prepareFeed(scope.graphId, [
            sourceChangeDraft(
              scope,
              object.objectId,
              input.attribution,
              change,
            ),
          ]);
      } catch (error) {
        throw new RetentionError('failed', { cause: error });
      }

      // Prepare the returned snapshot before mutating retained state.
      const result = {
        object: structuredClone(object),
        acceptance,
        ...(change ? { change } : {}),
      };

      if (!previous) {
        adoptions.set(canonicalJson([key, object.objectId]), {
          actor: structuredClone(input.attribution.actor),
          at: input.attribution.occurredAt,
        });
        population.order.push(object.objectId);
        population.sorted = false;
      }

      population.bySource.set(input.sourceRecordId, object);
      population.byObject.set(object.objectId, object);
      scopes.set(key, population);
      publish();

      return result;
    },
  };
}
