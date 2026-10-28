import { canonicalJson } from 'relate/model';
import type {
  FeedDraft,
  NativeStore,
  NativeScope,
  NativeRecord,
  NativeCreation,
  NativeInvocation,
  NativeScanOptions,
  StorageScope,
  TransactionalAcceptInput,
  TransactionalAcceptance,
} from './storage.js';
import {
  AdoptionConflict,
  NativeConflict,
  compareObjectIds,
  validateFeedDraft,
} from './storage.js';
import { startAfter } from './memory-order.js';

/** A source acceptance decided without mutating retained source state. */
export interface PreparedAdoption {
  readonly result: TransactionalAcceptance;
  /** Whether the identity is unchanged since preparation; never throws. */
  valid(): boolean;
  /** Publish the prepared write; synchronous and infallible. */
  apply(): void;
}

/** The owning source store's preparation step for transactional adoption. */
export interface MemorySourceAdoption {
  prepare(
    scope: StorageScope,
    input: TransactionalAcceptInput,
  ): PreparedAdoption;
}

/**
 * Private transaction snapshots; observation refreshes are independently
 * retained. Action adoptions are prepared privately and published with the
 * transaction's native writes and feed in one synchronous commit step.
 */
export function createNativeMemoryStore(
  installed: (scope: NativeScope) => boolean,
  /** Present when the owning store supports activity; prepares an atomic feed append. */
  prepareFeed?: (graphId: string, drafts: readonly FeedDraft[]) => () => void,
  /** Present when the owning store supports action adoption. */
  adoption?: MemorySourceAdoption,
): NativeStore {
  const graphs = new Map<
    string,
    {
      records: Map<string, NativeRecord>;
      creations: Map<string, NativeCreation>;
      invocations: Map<string, NativeInvocation>;
    }
  >();
  const locks = new Map<string, Promise<void>>();
  const recordKey = (type: string, id: string) => JSON.stringify([type, id]);
  const invocationKey = (action: string, key: string) =>
    JSON.stringify([action, key]);
  // Each record map's records of one type in object ID order, built on the
  // first scan and dropped when that type changes. Transactions clone the
  // record map, so a committed map's cache is never shared with a draft.
  const ordered = new WeakMap<
    Map<string, NativeRecord>,
    Map<string, NativeRecord[]>
  >();
  const invalidate = (records: Map<string, NativeRecord>, type: string) =>
    ordered.get(records)?.delete(type);

  function scan(
    records: Map<string, NativeRecord> | undefined,
    type: string,
    options: NativeScanOptions,
  ) {
    if (
      !Number.isInteger(options.limit) ||
      options.limit < 1 ||
      options.limit > 100
    )
      throw new Error('Invalid scan limit');

    if (!records) return { objects: [], hasMore: false };

    let byType = ordered.get(records);

    if (!byType) ordered.set(records, (byType = new Map()));

    let matches = byType.get(type);

    if (!matches) {
      matches = [...records.values()]
        .filter((r) => r.objectDefinitionId === type)
        .sort((a, b) => compareObjectIds(a.objectId, b.objectId));
      byType.set(type, matches);
    }

    const start = startAfter(matches, options.after, (r) => r.objectId);
    const page = matches.slice(start, start + options.limit + 1);

    return {
      objects: structuredClone(page.slice(0, options.limit)),
      hasMore: page.length > options.limit,
    };
  }

  return {
    ...(adoption ? { capabilities: { actionAdoption: true as const } } : {}),
    async scan(scope, type, options) {
      if (!installed(scope)) return { objects: [], hasMore: false };

      return scan(graphs.get(scope.graphId)?.records, type, options);
    },
    async loadInvocation(scope, action, key) {
      if (!installed(scope)) return undefined;

      const value = graphs
        .get(scope.graphId)
        ?.invocations.get(invocationKey(action, key));

      return value && structuredClone(value);
    },
    async load(scope, type, id) {
      if (!installed(scope)) return undefined;

      const value = graphs.get(scope.graphId)?.records.get(recordKey(type, id));

      return value && structuredClone(value);
    },
    async provenance(scope, object) {
      if (!installed(scope)) return undefined;

      const key = recordKey(object.objectDefinitionId, object.objectId);
      const state = graphs.get(scope.graphId);
      const record = state?.records.get(key);

      if (!record) return undefined;

      const creation = state!.creations.get(key);

      // The object's own insertion time and actor snapshot, never its receipt.
      return creation
        ? {
            kind: 'created',
            actor: structuredClone(creation.actor),
            at: new Date(record.createdAt).toISOString(),
            invocationId: creation.invocationId,
          }
        : { kind: 'unknown' };
    },
    async transaction(scope, operation) {
      const previous = locks.get(scope.graphId) ?? Promise.resolve();
      let release!: () => void;
      const lock = new Promise<void>((resolve) => {
        release = resolve;
      });
      const tail = previous.then(() => lock);

      locks.set(scope.graphId, tail);
      await previous;
      let active = true;
      const check = () => {
        if (!active || !installed(scope))
          throw new Error('Inactive native transaction');
      };

      try {
        check();
        const state = structuredClone(
          graphs.get(scope.graphId) ?? {
            records: new Map(),
            creations: new Map(),
            invocations: new Map(),
          },
        );
        const claimed = new Set<string>();
        const staged: FeedDraft[] = [];
        const adoptions = new Map<string, PreparedAdoption>();
        const undo: (() => void)[] = [];
        let savepointDepth = 0;
        const recordUndo = (operation: () => void) => {
          if (savepointDepth) undo.push(operation);
        };
        const result = await operation({
          async scan(type, options) {
            check();

            return scan(state.records, type, options);
          },
          async savepoint(operation) {
            check();
            const start = undo.length;

            savepointDepth++;

            try {
              return await operation();
            } catch (error) {
              check();

              for (let index = undo.length - 1; index >= start; index--)
                undo[index]!();

              undo.length = start;

              throw error;
            } finally {
              savepointDepth--;

              if (!savepointDepth) undo.length = 0;
            }
          },
          async load(type, id) {
            check();
            const value = state.records.get(recordKey(type, id));

            return value && structuredClone(value);
          },
          async insert(record, creation) {
            check();
            const key = recordKey(record.objectDefinitionId, record.objectId);

            if (state.records.has(key)) throw new NativeConflict();

            state.records.set(key, structuredClone(record));
            invalidate(state.records, record.objectDefinitionId);
            state.creations.set(key, {
              actor: { kind: creation.actor.kind, id: creation.actor.id },
              invocationId: creation.invocationId,
            });
            recordUndo(() => {
              state.records.delete(key);
              invalidate(state.records, record.objectDefinitionId);
              state.creations.delete(key);
            });
          },
          ...(adoption
            ? {
                async accept(
                  source: StorageScope,
                  input: TransactionalAcceptInput,
                ) {
                  check();

                  if (
                    source.graphId !== scope.graphId ||
                    source.definitionRevision !== scope.definitionRevision
                  )
                    throw new Error(
                      'Adoption scope is outside this transaction',
                    );

                  const key = canonicalJson([source, input.sourceRecordId]);

                  if (adoptions.has(key))
                    throw new Error('Duplicate adoption in one transaction');

                  const prepared = adoption.prepare(source, input);

                  adoptions.set(key, prepared);
                  recordUndo(() => {
                    adoptions.delete(key);
                  });

                  return structuredClone(prepared.result);
                },
              }
            : {}),
          ...(prepareFeed
            ? {
                async appendFeed(drafts: readonly FeedDraft[]) {
                  check();

                  for (const draft of drafts) validateFeedDraft(draft);

                  const length = staged.length;

                  staged.push(...structuredClone(drafts));
                  recordUndo(() => {
                    staged.length = length;
                  });
                },
              }
            : {}),
          async claim(action, key) {
            check();
            const scopeKey = invocationKey(action, key);

            if (claimed.has(scopeKey)) throw new NativeConflict();

            const existing = state.invocations.get(scopeKey);

            if (existing) return structuredClone(existing);

            claimed.add(scopeKey);
            recordUndo(() => {
              claimed.delete(scopeKey);
            });
          },
          async findInvocation(action, id) {
            check();
            const existing = [...state.invocations.values()].find(
              (entry) =>
                entry.actionDefinitionId === action &&
                entry.receipt.invocationId === id,
            );

            return existing && structuredClone(existing);
          },
          async saveInvocation(invocation) {
            check();
            const key = invocationKey(
              invocation.actionDefinitionId,
              invocation.idempotencyKey,
            );

            if (!claimed.delete(key))
              throw new Error('Invocation was not claimed');

            const previous = state.invocations.get(key);

            recordUndo(() => {
              claimed.add(key);

              if (previous) state.invocations.set(key, previous);
              else state.invocations.delete(key);
            });
            state.invocations.set(key, structuredClone(invocation));
          },
        });

        check();

        if (claimed.size) throw new Error('Unfinished native invocation');

        const snapshot = structuredClone(result);

        // A host write since preparation invalidates the action's view of
        // that identity; nothing below has been published yet.
        for (const prepared of adoptions.values())
          if (!prepared.valid()) throw new AdoptionConflict();

        // Final work before commit: a batch the feed cannot hold rolls back.
        const publish = prepareFeed?.(scope.graphId, staged) ?? (() => {});

        // One synchronous step: no await between validation and publication.
        for (const prepared of adoptions.values()) prepared.apply();

        graphs.set(scope.graphId, state);
        publish();

        return snapshot;
      } finally {
        active = false;
        release();

        if (locks.get(scope.graphId) === tail) locks.delete(scope.graphId);
      }
    },
  };
}
