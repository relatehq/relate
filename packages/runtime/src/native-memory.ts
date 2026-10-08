import type {
  NativeStore,
  NativeScope,
  NativeRecord,
  NativeInvocation,
  NativeScanOptions,
} from './storage.js';
import { NativeConflict, compareObjectIds } from './storage.js';

/** Private transaction snapshots; observation refreshes are independently retained. */
export function createNativeMemoryStore(
  installed: (scope: NativeScope) => boolean,
): NativeStore {
  const graphs = new Map<
    string,
    {
      records: Map<string, NativeRecord>;
      invocations: Map<string, NativeInvocation>;
    }
  >();
  const locks = new Map<string, Promise<void>>();
  const recordKey = (type: string, id: string) => JSON.stringify([type, id]);
  const invocationKey = (action: string, key: string) =>
    JSON.stringify([action, key]);

  function scan(
    records: Iterable<NativeRecord>,
    type: string,
    options: NativeScanOptions,
  ) {
    if (
      !Number.isInteger(options.limit) ||
      options.limit < 1 ||
      options.limit > 100
    )
      throw new Error('Invalid scan limit');

    const matches: NativeRecord[] = [];

    for (const r of records)
      if (
        r.objectDefinitionId === type &&
        (options.after === undefined ||
          compareObjectIds(r.objectId, options.after) > 0)
      )
        matches.push(r);

    matches.sort((a, b) => compareObjectIds(a.objectId, b.objectId));

    return {
      objects: structuredClone(matches.slice(0, options.limit)),
      hasMore: matches.length > options.limit,
    };
  }

  return {
    async scan(scope, type, options) {
      if (!installed(scope)) return { objects: [], hasMore: false };

      return scan(
        graphs.get(scope.graphId)?.records.values() ?? [],
        type,
        options,
      );
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
            invocations: new Map(),
          },
        );
        const claimed = new Set<string>();
        const undo: (() => void)[] = [];
        let savepointDepth = 0;
        const recordUndo = (operation: () => void) => {
          if (savepointDepth) undo.push(operation);
        };
        const result = await operation({
          async scan(type, options) {
            check();

            return scan(state.records.values(), type, options);
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
          async insert(record) {
            check();
            const key = recordKey(record.objectDefinitionId, record.objectId);

            if (state.records.has(key)) throw new NativeConflict();

            state.records.set(key, structuredClone(record));
            recordUndo(() => {
              state.records.delete(key);
            });
          },
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

        graphs.set(scope.graphId, state);

        return snapshot;
      } finally {
        active = false;
        release();

        if (locks.get(scope.graphId) === tail) locks.delete(scope.graphId);
      }
    },
  };
}
