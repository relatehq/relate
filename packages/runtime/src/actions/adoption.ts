import { randomUUID } from 'node:crypto';
import { canonicalJson } from 'relate/model';
import {
  AdoptionConflict,
  compareObjectIds,
  sourceChangeDraft,
} from '../storage.js';
import type {
  ObservationStore,
  StorageScope,
  StoredObject,
  NativeTransaction,
  FeedDraft,
} from '../storage.js';
import { compareObservation } from '../storage.js';

type Input = Parameters<ObservationStore['accept']>[1];

type Entry = {
  scope: StorageScope;
  object: StoredObject;
  isNew: boolean;
  input: Input;
};

const overlays = new WeakMap<NativeTransaction, AdoptionOverlay>();

export const actionOverlay = (transaction?: NativeTransaction) =>
  transaction ? overlays.get(transaction) : undefined;

export function attachAdoption(
  transaction: NativeTransaction,
  overlay: AdoptionOverlay,
) {
  overlays.set(transaction, overlay);
}

const key = (scope: StorageScope, id: string) => canonicalJson([scope, id]);

export class AdoptionOverlay {
  private active = true;
  private entries = new Map<string, Entry>();
  private byObject = new Map<string, Entry>();
  private locks = new Map<string, Promise<unknown>>();
  constructor(
    private store: ObservationStore,
    readonly invocationId: string,
    private check: () => void,
  ) {}
  find(scope: StorageScope, id: string, canonical = false) {
    return (canonical ? this.byObject : this.entries).get(key(scope, id));
  }

  pending(scope: StorageScope) {
    return [...this.entries.values()].filter(
      (e) => canonicalJson(e.scope) === canonicalJson(scope),
    );
  }
  get newIds() {
    return [...this.entries.values()]
      .filter((e) => e.isNew)
      .map((e) => ({
        objectDefinitionId: e.scope.objectDefinitionId,
        objectId: e.object.objectId,
      }));
  }
  close() {
    this.active = false;
  }
  discard() {
    this.close();
    this.entries.clear();
    this.byObject.clear();
  }
  async stage(scope: StorageScope, input: Input) {
    const identity = key(scope, input.sourceRecordId);
    const work = (this.locks.get(identity) ?? Promise.resolve()).then(
      async () => {
        this.check();

        if (!this.active) throw new AdoptionConflict();

        const previous = await this.store.resolve(scope, input.sourceRecordId);

        this.check();

        if (!this.active) throw new AdoptionConflict();

        const staged = this.entries.get(identity);

        if (staged && previous && staged.object.objectId !== previous.objectId)
          throw new AdoptionConflict();

        let winner = staged?.object ?? previous;

        try {
          if (
            winner &&
            previous &&
            compareObservation(winner.observation, previous.observation) !==
              'superseded'
          )
            winner = previous;

          const acceptance = compareObservation(
            winner?.observation,
            input.observation,
          );

          if (!winner || acceptance === 'changed' || acceptance === 'unchanged')
            winner = {
              objectId:
                staged?.object.objectId ?? previous?.objectId ?? randomUUID(),
              sourceRecordId: input.sourceRecordId,
              observation: input.observation,
            };
        } catch {
          throw new AdoptionConflict();
        }

        const entry = {
          scope,
          object: winner!,
          isNew: staged?.isNew ?? !previous,
          input,
        };

        this.entries.set(identity, entry);
        this.byObject.set(key(scope, entry.object.objectId), entry);

        return {
          object: structuredClone(entry.object),
          acceptance: 'unchanged' as const,
        };
      },
    );

    this.locks.set(identity, work);

    return work;
  }
  async commit(transaction: NativeTransaction): Promise<FeedDraft[]> {
    this.check();
    this.close();
    const drafts: FeedDraft[] = [];

    for (const entry of this.entries.values()) {
      const attribution = {
        ...entry.input.attribution,
        invocationId: this.invocationId,
      };
      const result = await transaction.accept!(entry.scope, {
        ...entry.input,
        adopt: true,
        objectId: entry.object.objectId,
        observation: entry.object.observation,
        attribution,
      });

      if (result.change)
        drafts.push(
          sourceChangeDraft(
            entry.scope,
            entry.object.objectId,
            attribution,
            result.change,
          ),
        );
    }

    return drafts;
  }
}

/** Only identities staged by this invocation intercept ordinary refresh retention. */
export function adoptionStore(
  store: ObservationStore,
  overlay?: AdoptionOverlay,
): ObservationStore {
  if (!overlay) return store;

  return {
    ...store,
    async load(scope, id) {
      return (
        structuredClone(overlay?.find(scope, id, true)?.object) ??
        store.load(scope, id)
      );
    },
    async resolve(scope, id) {
      return (
        structuredClone(overlay?.find(scope, id)?.object) ??
        store.resolve(scope, id)
      );
    },
    async loadMany(scope, ids) {
      const values = new Map(await store.loadMany(scope, ids));

      for (const id of ids) {
        const entry = overlay?.find(scope, id, true);

        if (entry) values.set(id, structuredClone(entry.object));
      }

      return values;
    },
    async accept(scope, input) {
      return overlay &&
        (input.adopt || overlay.find(scope, input.sourceRecordId))
        ? overlay.stage(scope, input)
        : store.accept(scope, input);
    },
    async scan(scope, options) {
      const batch = await store.scan(scope, options);
      const pending = overlay?.pending(scope) ?? [];
      const candidates = new Map(
        batch.objects.map((object) => [object.objectId, object]),
      );

      for (const entry of pending) {
        const duplicate = batch.objects.find(
          (o) =>
            o.sourceRecordId === entry.object.sourceRecordId &&
            o.objectId !== entry.object.objectId,
        );

        if (duplicate) throw new AdoptionConflict();

        if (
          !options.after ||
          compareObjectIds(entry.object.objectId, options.after) > 0
        )
          candidates.set(entry.object.objectId, entry.object);
      }

      const sorted = [...candidates.values()].sort((a, b) =>
        compareObjectIds(a.objectId, b.objectId),
      );

      return {
        objects: structuredClone(sorted.slice(0, options.limit)),
        hasMore: batch.hasMore || sorted.length > options.limit,
      };
    },
  };
}
