import {
  ActionError,
  ReadError,
  type Page,
  type QueryRequest,
  type QueryResult,
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
import {
  createRuntime as createEngine,
  createQuery,
  operationContracts,
} from '@relate/runtime';
import type { ObjectDescription as RuntimeObjectDescription } from '@relate/runtime';
import type { Principal } from '@relate/runtime';
import type { SourceBinding } from 'relate/connectors';
import type { ActionHandler } from '@relate/runtime';
import type { Consumer, ObjectDescription, Relate } from './types.js';

/** Bind paged options once; request errors reject the handle like other operations. */
function paged<R extends { readonly cursor?: string }, T>(
  operation: string,
  request: R,
  readPage: (request: R) => Promise<Page<T>>,
): QueryResult<T> {
  try {
    let captured: R;

    try {
      captured = structuredClone(request);
    } catch {
      throw new ReadError('invalid-request', {
        operation,
        issues: [
          {
            path: [],
            problem: 'invalid-value',
            message:
              'options must be plain data, without functions, symbols or class instances.',
          },
        ],
      });
    }

    return createQuery(
      (cursor) =>
        readPage({ ...captured, ...(cursor !== undefined ? { cursor } : {}) }),
      {
        operation,
        ...(captured.cursor !== undefined ? { cursor: captured.cursor } : {}),
      },
    );
  } catch (error) {
    return createQuery(() => Promise.reject(error));
  }
}

const inspect = Symbol.for('nodejs.util.inspect.custom');

/**
 * Printing an operation shows how to call it rather than its implementation, so
 * a REPL or log teaches the same contract discovery describes.
 */
function documented<F extends (...args: never[]) => unknown>(
  operation: F,
  signature: string,
): F {
  for (const key of ['toString', inspect])
    Object.defineProperty(operation, key, { value: () => signature });

  return operation;
}

const optionNames = (options: readonly string[]) =>
  `{ ${options.map((option) => `${option}?`).join(', ')} }`;

/** Add this SDK's call paths to the runtime's surface-neutral object detail. */
function withCalls(
  path: string,
  description: RuntimeObjectDescription | undefined,
): ObjectDescription | undefined {
  if (!description) return undefined;

  // Runtime detail is already frozen; freeze only the members added here.
  const { freeze } = Object;

  return freeze({
    ...description,
    operations: freeze({
      get: freeze({
        ...description.operations.get,
        call: `${path}.get(id, options?)`,
      }),
      query: freeze({
        ...description.operations.query,
        call: `${path}.query(options?)`,
      }),
    }),
    traversals: freeze(
      description.traversals.map((traversal) =>
        freeze({
          ...traversal,
          call: `${path}.traverse.${traversal.name}(id, options?)`,
        }),
      ),
    ),
  });
}

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
              query: (request: QueryRequest = {}) =>
                paged(`${name}.query`, request, (page) =>
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
  const apiNames = new Map(
    objects.map(([name, object]) => [object.id, name] as const),
  );
  const traversalsOf = (objectId: string) =>
    (model.manifest.relationships ?? []).flatMap((r) => [
      ...(r.fromObjectDefinitionId === objectId
        ? [
            {
              traversal: r.forward,
              target: apiNames.get(r.toObjectDefinitionId),
            },
          ]
        : []),
      ...(r.toObjectDefinitionId === objectId
        ? [
            {
              traversal: r.reverse,
              target: apiNames.get(r.fromObjectDefinitionId),
            },
          ]
        : []),
    ]);
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
      const discovery = engine.discover(actor);
      const operations = Object.fromEntries(
        objects.map(([name, object]) => {
          const path = `objects.${name}`;
          let described: ObjectDescription | undefined;

          return [
            name,
            Object.freeze({
              describe: () => {
                if (closed) throw new Error('Relate is closed');

                return (described ??= withCalls(
                  path,
                  discovery.describeObject(object.id),
                ));
              },
              traverse: Object.freeze(
                Object.fromEntries(
                  traversalsOf(object.id).map(({ traversal, target }) => {
                    const operation = `${name}.traverse.${traversal.name}`;
                    const signature =
                      traversal.cardinality === 'one'
                        ? `${path}.traverse.${traversal.name}(id: ObjectId<${name}>, options?: ${optionNames(operationContracts.traverse.one.options)}): Promise<ObjectResult<${target}>>`
                        : `${path}.traverse.${traversal.name}(id: ObjectId<${name}>, options?: ${optionNames(operationContracts.traverse.many.options)}): QueryResult<${target}>`;

                    return [
                      traversal.name,
                      documented(
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

                          return paged(operation, request, (page) =>
                            run(async () => {
                              const result = await engine.traverse(
                                actor,
                                object.id,
                                id,
                                traversal.name,
                                page,
                              );

                              if ('status' in result)
                                throw new Error(
                                  'Invalid to-many traversal result',
                                );

                              return result;
                            }),
                          );
                        },
                        signature,
                      ),
                    ];
                  }),
                ),
              ),
              query: documented(
                (request: QueryRequest = {}) =>
                  paged(`${name}.query`, request, (page) =>
                    run(() => engine.query(actor, object.id, page)),
                  ),
                `${path}.query(options?: ${optionNames(operationContracts.query.options)}): QueryResult<${name}>`,
              ),
              get: documented(
                (id: string, request = {}) =>
                  run(async () => {
                    const result = await engine.read(
                      actor,
                      object.id,
                      id,
                      request,
                    );

                    return result.status === 'ok' ? { ...result, id } : result;
                  }),
                `${path}.get(id: ObjectId<${name}>, options?: ${optionNames(operationContracts.get.options)}): Promise<ObjectResult<${name}>>`,
              ),
            }),
          ];
        }),
      );

      // Compilation validates schema support; the engine validates values and selection.
      // The registry gives each operation exactly the definition used by that compiler.
      return Object.freeze({
        describe: () => {
          if (closed) throw new Error('Relate is closed');

          return discovery.describe();
        },
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
            actions.map(([name, action]) => {
              const invoke = (request: {
                input: unknown;
                idempotencyKey: string;
              }) => run(() => engine.invoke(actor, action.id, request));

              Object.defineProperty(invoke, 'describe', {
                value: () => {
                  if (closed) throw new Error('Relate is closed');

                  return discovery.describeAction(action.id);
                },
                enumerable: true,
              });

              return [name, Object.freeze(invoke)];
            }),
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
