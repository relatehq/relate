import type {
  NativeStore,
  NativeScope,
  NativeRecord,
  NativeInvocation,
} from './storage.js';
import { NativeConflict } from './storage.js';

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

  return {
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
        const result = await operation({
          async savepoint(operation) {
            check();
            const snapshot = structuredClone(state);
            const claims = new Set(claimed);

            try {
              return await operation();
            } catch (error) {
              check();
              state.records = snapshot.records;
              state.invocations = snapshot.invocations;
              claimed.clear();

              for (const key of claims) claimed.add(key);

              throw error;
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
          },
          async claim(action, key) {
            check();
            const scopeKey = invocationKey(action, key);

            if (claimed.has(scopeKey)) throw new NativeConflict();

            const existing = state.invocations.get(scopeKey);

            if (existing) return structuredClone(existing);

            claimed.add(scopeKey);
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
