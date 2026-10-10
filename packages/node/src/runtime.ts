import type { ConsumerOperations, QueryRequest } from '@relate/protocol';
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
import { createConsumer, createPagedQuery } from 'relate/consumer';
import type { Consumer } from 'relate/consumer';
import { createRuntime as createEngine } from '@relate/runtime';
import type { Principal } from '@relate/runtime';
import type { SourceBinding } from 'relate/connectors';
import type { ActionHandler } from '@relate/runtime';
import type { Relate } from './types.js';

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
  // Keep every later facade aligned with this compiled model. Definitions are
  // immutable, but the graph and its caller-owned registries need not be.
  const consumerGraph = {
    ...options.graph,
    objects: { ...options.graph.objects },
    ...(options.graph.relationships
      ? { relationships: { ...options.graph.relationships } }
      : {}),
    ...(options.graph.actions ? { actions: { ...options.graph.actions } } : {}),
  };
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
              query: (request: QueryRequest = {}) =>
                createPagedQuery(`${name}.query`, request, (page) =>
                  context.query(object.id, page),
                ),
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
  const open = () => {
    if (closed) throw new Error('Relate is closed');
  };
  const run = async <T>(operation: () => Promise<T>): Promise<T> => {
    open();

    const result = operation();

    pending.add(result);

    try {
      return await result;
    } finally {
      pending.delete(result);
    }
  };

  /** Bind one host-authenticated principal; every call is tracked for `close()`. */
  function operations(principal: Principal): ConsumerOperations {
    open();

    // A handle binds a snapshot of the host-authenticated principal.
    const actor = structuredClone(principal);
    const discovery = engine.discover(actor);
    const bound: ConsumerOperations = {
      discovery: Object.freeze({
        describe: () => {
          open();

          return discovery.describe();
        },
        describeObject: (objectDefinitionId: string) => {
          open();

          return discovery.describeObject(objectDefinitionId);
        },
        describeAction: (actionDefinitionId: string) => {
          open();

          return discovery.describeAction(actionDefinitionId);
        },
      }),
      read: (objectDefinitionId, objectId, request) =>
        run(() => engine.read(actor, objectDefinitionId, objectId, request)),
      query: (objectDefinitionId, request) =>
        run(() => engine.query(actor, objectDefinitionId, request)),
      traverse: (objectDefinitionId, objectId, traversal, request) =>
        run(() =>
          engine.traverse(
            actor,
            objectDefinitionId,
            objectId,
            traversal,
            request,
          ),
        ),
      invoke: (actionDefinitionId, request) =>
        run(() => engine.invoke(actor, actionDefinitionId, request)),
      getReceipt: (actionDefinitionId, invocationId) =>
        run(() => engine.getReceipt(actor, actionDefinitionId, invocationId)),
    };

    return Object.freeze(bound);
  }

  return {
    as(principal: Principal): Consumer<G> {
      // Compilation validated schema support; the engine validates values and selection.
      return createConsumer(consumerGraph, operations(principal));
    },
    operations,
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
