import type { TraversalRequest } from '@relate/protocol';
import { compile } from 'relate/compiler';
import type {
  GraphDefinition,
  ObjectDefinition,
  ObjectRegistry,
  SourceDefinition,
} from 'relate';
import { createRuntime as createEngine, createQuery } from '@relate/runtime';
import type { Principal, RuntimeOptions, SourceBinding } from '@relate/runtime';
import type { Consumer, Relate } from './types.js';

export type { QueryResult } from '@relate/runtime';

export type {
  Consumer,
  ObjectResult,
  ObjectRecord,
  Page,
  PageOptions,
  ObjectOperations,
  ReadOptions,
  Relate,
} from './types.js';

export interface Connection extends SourceBinding {
  readonly source: SourceDefinition;
}

/** This slice supports shared service credentials only. Credentials stay in the connector. */
export function connect(
  source: SourceDefinition,
  binding: Omit<SourceBinding, 'authorization'> & {
    readonly authorization?: 'shared-service';
  },
): Connection {
  return Object.freeze({
    ...binding,
    source,
    authorization: binding.authorization ?? 'shared-service',
  });
}

export interface AppOptions<
  G extends GraphDefinition & { readonly objects: ObjectRegistry },
> {
  readonly graph: G;
  readonly connections: readonly Connection[];
  readonly graphId?: string;
  /** Borrowed storage: the caller owns migrations and closing it. */
  readonly store?: RuntimeOptions['store'];
  readonly clock?: RuntimeOptions['clock'];
  readonly cursorKey?: Uint8Array;
}

/** Compile an authored graph and compose the existing read engine. */
export function createRuntime<
  G extends GraphDefinition & { readonly objects: ObjectRegistry },
>(options: AppOptions<G>): Relate<G> {
  const model = compile(options.graph);
  const objects = Object.entries(options.graph.objects);
  const registered = new Set<ObjectDefinition>(
    objects.map(([, object]) => object),
  );
  const resources = new Set(
    objects.map(([, object]) => object.membership.resource),
  );
  const sources: Record<string, SourceBinding> = {};

  for (const connection of options.connections) {
    if (!resources.has(connection.source))
      throw new Error('Unregistered source connection');

    if (Object.hasOwn(sources, connection.source.id))
      throw new Error('Duplicate source connection');

    Object.defineProperty(sources, connection.source.id, {
      value: connection,
      enumerable: true,
    });
  }

  const engine = createEngine({
    model,
    graphId: options.graphId ?? options.graph.id,
    sources,
    ...(options.store ? { store: options.store } : {}),
    ...(options.clock ? { clock: options.clock } : {}),
    ...(options.cursorKey ? { cursorKey: options.cursorKey } : {}),
  });
  let closed = false;
  const pending = new Set<Promise<unknown>>();
  const run = async <T>(operation: () => Promise<T>): Promise<T> => {
    if (closed) throw new Error('Relate is closed');

    const result = operation();

    pending.add(result);

    try {
      return await result;
    } finally {
      pending.delete(result);
    }
  };

  return {
    as(principal: Principal): Consumer<G> {
      if (closed) throw new Error('Relate is closed');

      // A handle binds a snapshot of the host-authenticated principal.
      const actor = structuredClone(principal);
      const operations = Object.fromEntries(
        objects.map(([name, object]) => [
          name,
          Object.freeze({
            traverse: Object.freeze(
              Object.fromEntries(
                (model.manifest.relationships ?? [])
                  .flatMap((r) => [
                    ...(r.fromObjectDefinitionId === object.id
                      ? [r.forward]
                      : []),
                    ...(r.toObjectDefinitionId === object.id
                      ? [r.reverse]
                      : []),
                  ])
                  .map((traversal) => [
                    traversal.name,
                    (id: string, request: TraversalRequest = {}) => {
                      if (traversal.cardinality === 'one')
                        return run(() =>
                          engine.traverse(
                            actor,
                            object.id,
                            id,
                            traversal.name,
                            request,
                          ),
                        );

                      const captured = structuredClone(request);

                      return createQuery(
                        async (cursor) =>
                          run(async () => {
                            const result = await engine.traverse(
                              actor,
                              object.id,
                              id,
                              traversal.name,
                              {
                                ...captured,
                                ...(cursor !== undefined ? { cursor } : {}),
                              },
                            );

                            if ('status' in result)
                              throw new Error(
                                'Invalid to-many traversal result',
                              );

                            return result;
                          }),
                        captured.cursor !== undefined
                          ? { cursor: captured.cursor }
                          : {},
                      );
                    },
                  ]),
              ),
            ),
            get: (id: string, request = {}) =>
              run(async () => {
                const result = await engine.read(actor, object.id, id, request);

                return result.status === 'ok' ? { ...result, id } : result;
              }),
          }),
        ]),
      );

      // Compilation validates schema support; the engine validates values and selection.
      // The registry gives each operation exactly the definition used by that compiler.
      return Object.freeze({
        objects: Object.freeze(operations),
      }) as Consumer<G>;
    },
    host: Object.freeze({
      adopt: (
        object: G['objects'][keyof G['objects']],
        sourceRecordId: string,
      ) =>
        run(async () => {
          if (!registered.has(object))
            throw new Error('Unregistered adoption target');

          return engine.adopt(object.id, sourceRecordId);
        }),
    }),
    async close() {
      closed = true;
      await Promise.allSettled([...pending]);
    },
  };
}
