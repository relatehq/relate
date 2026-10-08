import {
  ActionError,
  type QueryRequest,
  type TraversalRequest,
} from '@relate/protocol';
import { compile } from 'relate/compiler';
import type {
  ActionDefinition,
  ActionImplementation,
  GraphDefinition,
  ObjectDefinition,
  ObjectId,
  ObjectRegistry,
  AppBindings,
} from 'relate';
import { createRuntime as createEngine, createQuery } from '@relate/runtime';
import type { Principal } from '@relate/runtime';
import type { SourceBinding } from 'relate/connectors';
import type { ActionHandler } from '@relate/runtime';
import type { Consumer, Relate } from './types.js';

export interface AppOptions<
  G extends GraphDefinition & { readonly objects: ObjectRegistry },
> extends AppBindings<G> {
  readonly graph: G;
}

/** Compile an authored graph and bind typed reads and native action handlers. */
export function createRuntime<
  G extends GraphDefinition & { readonly objects: ObjectRegistry },
>(options: AppOptions<G>): Relate<G> {
  const model = compile(options.graph);
  const objects = Object.entries(options.graph.objects);
  const registered = new Set<ObjectDefinition>(
    objects.map(([, object]) => object),
  );
  const resources = new Set(
    objects.flatMap(([, object]) =>
      'resource' in object.membership ? [object.membership.resource] : [],
    ),
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

  const actions = Object.entries(options.graph.actions ?? {});
  const handlers: Record<string, ActionHandler> = {};

  for (const registered of options.actionImplementations ?? []) {
    const implementation = registered as unknown as ActionImplementation<
      G,
      ActionDefinition
    >;

    if (
      implementation.graph !== options.graph ||
      !actions.some(([, action]) => action === implementation.action)
    )
      throw new Error('Unregistered action implementation');

    if (Object.hasOwn(handlers, implementation.action.id))
      throw new Error('Duplicate action implementation');

    handlers[implementation.action.id] = (context) =>
      implementation.implementation({
        actor: context.actor,
        input: context.input,
        fail: context.fail,
        objects: Object.fromEntries(
          objects.map(([name, object]) => [
            name,
            Object.freeze({
              query: (request: QueryRequest = {}) => {
                const captured = structuredClone(request);

                return createQuery(
                  (cursor) =>
                    context.query(object.id, {
                      ...captured,
                      ...(cursor !== undefined ? { cursor } : {}),
                    }),
                  captured.cursor !== undefined
                    ? { cursor: captured.cursor }
                    : {},
                );
              },
              get: async (id: string, request = {}) => {
                const result = await context.read(object.id, id, request);

                return result.status === 'ok' ? { ...result, id } : result;
              },
              ...(implementation.action.creates.includes(object as never)
                ? {
                    create: (values: unknown) =>
                      context.create(object.id, values),
                  }
                : {}),
            }),
          ]),
        ) as never,
      });
  }

  if (actions.some(([, action]) => !Object.hasOwn(handlers, action.id)))
    throw new Error('Missing action implementation');

  const engine = createEngine({
    model,
    graphId: options.graphId ?? options.graph.id,
    sources,
    actionHandlers: handlers,
    ...(options.actionTimeoutMs !== undefined
      ? { actionTimeoutMs: options.actionTimeoutMs }
      : {}),
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
            query: (request: QueryRequest = {}) => {
              const captured = structuredClone(request);

              return createQuery(
                (cursor) =>
                  run(() =>
                    engine.query(actor, object.id, {
                      ...captured,
                      ...(cursor !== undefined ? { cursor } : {}),
                    }),
                  ),
                captured.cursor !== undefined
                  ? { cursor: captured.cursor }
                  : {},
              );
            },
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
        receipts: Object.freeze({
          get: (action: ActionDefinition, invocationId: string) =>
            run(async () => {
              if (!actions.some(([, registered]) => registered === action))
                throw new ActionError('denied');

              return engine.getReceipt(actor, action.id, invocationId);
            }),
        }),
        actions: Object.freeze(
          Object.fromEntries(
            actions.map(([name, action]) => [
              name,
              (request: { input: unknown; idempotencyKey: string }) =>
                run(() => engine.invoke(actor, action.id, request)),
            ]),
          ),
        ),
      }) as unknown as Consumer<G>;
    },
    host: Object.freeze({
      adopt: <
        O extends Extract<
          G['objects'][keyof G['objects']],
          { membership: { resource: unknown } }
        >,
      >(
        object: O,
        sourceRecordId: string,
      ) =>
        run(async () => {
          if (!registered.has(object))
            throw new Error('Unregistered adoption target');

          // Adoption establishes the canonical ID for this registered definition.
          return (await engine.adopt(object.id, sourceRecordId)) as ObjectId<
            O['id']
          >;
        }),
    }),
    async close() {
      closed = true;
      await Promise.allSettled([...pending]);
    },
  };
}
