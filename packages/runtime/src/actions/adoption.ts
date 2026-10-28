import { randomUUID } from 'node:crypto';
import { canonicalJson } from 'relate/model';
import { ActionError, ReadError } from '@relate/protocol';
import type {
  Acceptance,
  AcceptedChange,
  NativeTransaction,
  Observation,
  ObservationStore,
  StorageScope,
  StoredObject,
} from '../storage.js';
import {
  AdoptionConflict,
  compareObjectIds,
  compareObservation,
  describeAcceptedChange,
  OrderingConflict,
} from '../storage.js';

/** One identity adopted, or re-adopted, during a running action invocation. */
export interface PendingAdoption {
  readonly scope: StorageScope;
  readonly sourceRecordId: string;
  /** Fixed for the invocation once staged; native records and output may use it. */
  readonly objectId: string;
  /** Whether the identity had no committed member when first staged. */
  readonly isNew: boolean;
  /** The ordered winner of every observation this invocation fetched or saw. */
  readonly observation: Observation;
  /** Advances whenever the staged observation is replaced. */
  readonly version: number;
}

const scopeKey = (scope: StorageScope) => canonicalJson(scope);

/**
 * Invocation-local pending adoptions, consulted before committed storage by
 * reads, queries and policy resolution in the same action. Nothing here is
 * durable: the executor accepts sealed entries in its transaction, and any
 * other outcome discards them.
 */
export class AdoptionOverlay {
  readonly #byIdentity = new Map<string, PendingAdoption>();
  readonly #byObject = new Map<string, PendingAdoption>();
  readonly #locks = new Map<string, Promise<void>>();
  #state: 'open' | 'sealed' | 'revoked' = 'open';
  #conflict: unknown;

  constructor(private readonly check: () => void = () => {}) {}

  get size() {
    return this.#byIdentity.size;
  }

  #writable() {
    this.check();

    if (this.#state !== 'open') throw new Error('Inactive adoption staging');
  }

  /** The staged identity for a source record ID in this exact scope. */
  find(scope: StorageScope, sourceRecordId: string): StoredObject | undefined {
    return snapshot(
      this.#byIdentity.get(canonicalJson([scopeKey(scope), sourceRecordId])),
    );
  }

  /** The staged identity for a Relate ID in this exact scope. */
  get(scope: StorageScope, objectId: string): StoredObject | undefined {
    return snapshot(
      this.#byObject.get(canonicalJson([scopeKey(scope), objectId])),
    );
  }

  /** Staged identities of one scope in bytewise Relate-ID order. */
  list(scope: StorageScope): StoredObject[] {
    const key = scopeKey(scope);

    return [...this.#byIdentity.values()]
      .filter((entry) => scopeKey(entry.scope) === key)
      .sort((a, b) => compareObjectIds(a.objectId, b.objectId))
      .map((entry) => snapshot(entry)!);
  }

  /** Observation versions of every entry, for detecting replaced validation views. */
  versions(): string {
    return canonicalJson(
      [...this.#byIdentity.entries()].map(([key, entry]) => [
        key,
        entry.version,
      ]),
    );
  }

  /** Every staged identity's Relate ID and object type. */
  members(): { objectDefinitionId: string; objectId: string }[] {
    return [...this.#byIdentity.values()].map((entry) => ({
      objectDefinitionId: entry.scope.objectDefinitionId,
      objectId: entry.objectId,
    }));
  }

  /** Relate IDs first staged by this invocation, with their object types. */
  newMembers(): { objectDefinitionId: string; objectId: string }[] {
    return [...this.#byIdentity.values()]
      .filter((entry) => entry.isNew)
      .map((entry) => ({
        objectDefinitionId: entry.scope.objectDefinitionId,
        objectId: entry.objectId,
      }));
  }

  /** Ordering evidence that conflicted while staging; it aborts the invocation. */
  get conflict(): unknown {
    return this.#conflict;
  }

  /**
   * Stage a fetched present observation for one identity. Staging of one
   * identity is serialized; fetches stay concurrent. The first staged ID is
   * kept, and observations are ordered, never replaced by arrival order.
   */
  async stage(
    scope: StorageScope,
    sourceRecordId: string,
    incoming: Observation,
    resolve: () => Promise<StoredObject | undefined>,
  ): Promise<StoredObject> {
    const key = canonicalJson([scopeKey(scope), sourceRecordId]);
    const previous = this.#locks.get(key) ?? Promise.resolve();
    let release!: () => void;
    const lock = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.then(() => lock);

    this.#locks.set(key, tail);

    try {
      await previous;
      this.#writable();
      // Database lookup only; no source I/O under this identity's section.
      const existing = await resolve();

      this.#writable();
      const staged = this.#byIdentity.get(key);

      // An ID already handed to the handler is never substituted.
      if (staged && existing && existing.objectId !== staged.objectId)
        throw new AdoptionConflict();

      const observation = this.#ordered(
        [existing?.observation, staged?.observation, incoming],
        key,
      );

      // Merging never resurrects a tombstone with an older present response.
      if (observation.state !== 'present') throw new ActionError('not-found');

      const entry: PendingAdoption = {
        scope: structuredClone(scope),
        sourceRecordId,
        objectId: staged?.objectId ?? existing?.objectId ?? randomUUID(),
        isNew: staged?.isNew ?? !existing,
        observation: structuredClone(observation),
        version: staged
          ? staged.observation.token === observation.token &&
            staged.observation.observedAt === observation.observedAt
            ? staged.version
            : staged.version + 1
          : 0,
      };

      this.#set(key, entry);

      return snapshot(entry)!;
    } finally {
      release();

      if (this.#locks.get(key) === tail) this.#locks.delete(key);
    }
  }

  /**
   * Stage a refreshed observation of an already staged identity, as the
   * read path's acceptance. Ordered like committed acceptance; never durable.
   */
  refresh(
    scope: StorageScope,
    sourceRecordId: string,
    incoming: Observation,
    changeId: string,
  ): { object: StoredObject; acceptance: Acceptance; change?: AcceptedChange } {
    this.#writable();
    const key = canonicalJson([scopeKey(scope), sourceRecordId]);
    const entry = this.#byIdentity.get(key);

    if (!entry) throw new Error('Identity is not staged');

    let acceptance: Acceptance;

    try {
      acceptance = compareObservation(entry.observation, incoming);
    } catch (error) {
      this.#conflict ??= error;
      throw error;
    }

    if (acceptance !== 'changed' && acceptance !== 'unchanged')
      return { object: snapshot(entry)!, acceptance };

    const transition = describeAcceptedChange(entry.observation, incoming);
    const next: PendingAdoption = {
      ...entry,
      observation: structuredClone(incoming),
      version: entry.version + 1,
    };

    this.#set(key, next);

    return {
      object: snapshot(next)!,
      acceptance,
      ...(transition ? { change: { id: changeId, ...transition } } : {}),
    };
  }

  /**
   * Stop staging and return every entry in a stable scope and identity order.
   * After this, no reads may refresh into the overlay.
   */
  seal(): PendingAdoption[] {
    this.#writable();

    if (this.#conflict !== undefined)
      throw new AdoptionConflict({ cause: this.#conflict });

    this.#state = 'sealed';

    return [...this.#byIdentity.entries()]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([, entry]) => structuredClone(entry));
  }

  /**
   * The read path's view of staged identities: loads and acceptances go to
   * the overlay, so a refresh never commits a staged identity independently.
   */
  store(store: ObservationStore): ObservationStore {
    return {
      ...store,
      load: async (scope, objectId) => this.get(scope, objectId),
      accept: async (scope, input) =>
        this.refresh(
          scope,
          input.sourceRecordId,
          input.observation,
          input.attribution.changeId,
        ),
    };
  }

  /** Revoke staging and forget every pending entry; reads see committed storage. */
  discard() {
    this.#state = 'revoked';
    this.#byIdentity.clear();
    this.#byObject.clear();
  }

  /** Revoke staging without forgetting entries, for late continuations. */
  revoke() {
    if (this.#state === 'open') this.#state = 'revoked';
  }

  #set(key: string, entry: PendingAdoption) {
    this.#byIdentity.set(key, entry);
    this.#byObject.set(
      canonicalJson([scopeKey(entry.scope), entry.objectId]),
      entry,
    );
  }

  #ordered(observations: (Observation | undefined)[], key: string) {
    let winner: Observation | undefined;

    for (const observation of observations) {
      if (!observation) continue;

      let acceptance: Acceptance;

      try {
        acceptance = compareObservation(winner, observation);
      } catch (error) {
        if (error instanceof OrderingConflict) {
          this.#conflict ??= error;
          throw new AdoptionConflict({ cause: error });
        }

        throw error;
      }

      if (acceptance === 'changed' || acceptance === 'unchanged')
        winner = observation;
    }

    if (!winner) throw new Error(`No observation for ${key}`);

    return winner;
  }
}

function snapshot(
  entry: PendingAdoption | undefined,
): StoredObject | undefined {
  return (
    entry &&
    structuredClone({
      objectId: entry.objectId,
      sourceRecordId: entry.sourceRecordId,
      observation: entry.observation,
    })
  );
}

const overlays = new WeakMap<NativeTransaction, AdoptionOverlay>();

/** Bind an invocation's overlay to the transaction handle its reads receive. */
export function bindAdoptionOverlay(
  transaction: NativeTransaction,
  overlay: AdoptionOverlay,
) {
  overlays.set(transaction, overlay);
}

/** The overlay of the action invocation that owns this transaction handle. */
export function adoptionOverlay(
  transaction: NativeTransaction | undefined,
): AdoptionOverlay | undefined {
  return transaction ? overlays.get(transaction) : undefined;
}

/**
 * One page of a source membership scan merged with this invocation's pending
 * identities: a sorted merge by Relate ID, staged observations replacing
 * committed snapshots. Pending IDs past a full committed page wait for a
 * later page, so no record is skipped or counted twice.
 */
export async function scanWithPending(
  overlay: AdoptionOverlay | undefined,
  scope: StorageScope,
  request: { after?: string; limit: number },
  committed: (request: {
    after?: string;
    limit: number;
  }) => Promise<{ objects: readonly StoredObject[]; hasMore: boolean }>,
): Promise<{ objects: readonly StoredObject[]; hasMore: boolean }> {
  const page = await committed(request);
  const pending = overlay?.list(scope) ?? [];

  if (!pending.length) return page;

  const merged = new Map<string, StoredObject>();

  for (const object of page.objects) {
    const staged = overlay!.find(scope, object.sourceRecordId);

    // Never expose two IDs for one identity.
    if (staged && staged.objectId !== object.objectId)
      throw new ReadError('unavailable');

    merged.set(object.objectId, staged ?? object);
  }

  const bound = page.hasMore ? page.objects.at(-1)?.objectId : undefined;

  for (const entry of pending) {
    if (
      (request.after !== undefined &&
        compareObjectIds(entry.objectId, request.after) <= 0) ||
      (bound !== undefined && compareObjectIds(entry.objectId, bound) > 0)
    )
      continue;

    merged.set(entry.objectId, entry);
  }

  const objects = [...merged.values()].sort((a, b) =>
    compareObjectIds(a.objectId, b.objectId),
  );

  return {
    objects: objects.slice(0, request.limit),
    hasMore: page.hasMore || objects.length > request.limit,
  };
}
