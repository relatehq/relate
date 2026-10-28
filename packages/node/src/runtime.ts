import { bindHostResources } from './bindings.js';
import type { HostBindings } from './bindings.js';
import type {
  ActivityActor,
  ActivityObjectRef,
  ConsumerOperations,
  OperationActor,
  OperationContext,
  CollectionReadControls,
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
  SourceMembership,
} from 'relate';
import { createConsumer, createPagedQuery } from 'relate/consumer';
import type { Consumer } from 'relate/consumer';
import {
  createOperationScope,
  createRuntime as createEngine,
  hostActor,
  validateDeclaredCalculations,
  resolveAnalyticalLimits,
} from '@relate/runtime';
import type { OperationScope, Principal } from '@relate/runtime';
import type { SqlParser } from 'relate/analytics';
import type { ActionHandler } from '@relate/runtime';
import type { Relate } from './types.js';

/** Consumer operations a trusted transport may dispatch with its own identity. */
export type DispatchMethod = Exclude<keyof ConsumerOperations, 'discovery'>;

/**
 * Operation identity assigned by a trusted transport, such as the `relate dev`
 * runtime host joining its display to runtime rows. One ID per call.
 */
export interface HostDispatch {
  /** UUIDv7; never reused across calls. */
  readonly operationId: string;
  readonly context?: Partial<OperationContext>;
}

/** Trusted host attribution for host operations such as adoption. */
export interface HostAttribution {
  /** Defaults to the named system actor `relate.host`. */
  readonly actor?: OperationActor;
  readonly context?: Partial<OperationContext>;
}

const actorKinds = new Set(['principal', 'system']);

function hostAttribution(attribution?: HostAttribution): OperationActor {
  const actor = attribution?.actor ?? hostActor;

  if (
    !actor ||
    !actorKinds.has(actor.kind) ||
    typeof actor.id !== 'string' ||
    !actor.id.trim()
  )
    throw new Error('Host actor must be a principal or system actor');

  return { kind: actor.kind, id: actor.id };
}

/** Trusted transport context; it cannot override the actor or revision. */
function requestContext(
  context: Partial<OperationContext>,
): Partial<OperationContext> {
  const text = (value: unknown) =>
    value === undefined || (typeof value === 'string' && value.trim());

  if (
    !context ||
    typeof context !== 'object' ||
    !text(context.requestId) ||
    !text(context.executionId) ||
    !text(context.runtimeId) ||
    (context.transport !== undefined &&
      !['embedded', 'http', 'mcp'].includes(context.transport))
  )
    throw new Error('Invalid operation context');

  const initiator = context.initiator as ActivityActor | undefined;

  if (
    initiator !== undefined &&
    (!['principal', 'system', 'source'].includes(initiator?.kind) ||
      typeof initiator.id !== 'string' ||
      !initiator.id.trim())
  )
    throw new Error('Invalid operation initiator');

  return {
    ...(context.requestId !== undefined
      ? { requestId: context.requestId }
      : {}),
    ...(context.transport !== undefined
      ? { transport: context.transport }
      : {}),
    ...(context.executionId !== undefined
      ? { executionId: context.executionId }
      : {}),
    ...(context.runtimeId !== undefined
      ? { runtimeId: context.runtimeId }
      : {}),
    ...(initiator
      ? { initiator: { kind: initiator.kind, id: initiator.id } }
      : {}),
  };
}

export interface AppOptions<
  G extends GraphDefinition & { readonly objects: ObjectRegistry },
> extends AppBindings<G> {
  readonly graph: G;
}

type StartupOptions<
  G extends GraphDefinition & { readonly objects: ObjectRegistry },
> = AppOptions<G> & { readonly sqlParser?: SqlParser };

/** Compile an authored graph and bind typed reads and native action handlers. */
function prepareHost<
  G extends GraphDefinition & { readonly objects: ObjectRegistry },
>(options: StartupOptions<G>) {
  const shutdownTimeoutMs = options.shutdownTimeoutMs ?? 5000;

  if (
    !Number.isSafeInteger(shutdownTimeoutMs) ||
    shutdownTimeoutMs < 1 ||
    shutdownTimeoutMs > 2147483647
  )
    throw new Error('shutdownTimeoutMs must be between 1 and 2147483647');

  const limits = resolveAnalyticalLimits(options.analytics);
  const model = compile(options.graph);
  const analytical = Boolean(
    model.manifest.datasets?.length ||
    model.manifest.objects.some((object) => object.calculations?.length),
  );

  if (analytical && !options.sqlParser)
    throw new Error(
      'Analytical graphs require asynchronous startup. Use startApp().',
    );

  if (analytical)
    validateDeclaredCalculations(model.manifest, options.sqlParser!, limits);

  return {
    model,
    limits,
    bindings: bindHostResources(options.graph, model, options.bindings, {
      concurrency: limits.maxConcurrentStatements,
      maxQueued: limits.maxQueuedStatements,
      maxWaitMs: limits.queueTimeoutMs,
    }),
  };
}

/** Compile and bind ordinary graphs synchronously; analytical graphs use startApp. */
export function createRuntime<
  G extends GraphDefinition & { readonly objects: ObjectRegistry },
>(options: AppOptions<G>): Relate<G> {
  const { model, bindings, limits } = prepareHost(options);

  return composeRuntime({ ...options, analytics: limits }, model, bindings);
}

/** Internal asynchronous composition used by startApp; no readiness surface escapes. */
export async function startRuntime<
  G extends GraphDefinition & { readonly objects: ObjectRegistry },
>(options: StartupOptions<G>): Promise<Relate<G>> {
  const { model, bindings, limits } = prepareHost(options);
  let runtime: Relate<G> | undefined;

  try {
    // Capture all registries and validate ordinary bindings before asynchronous inspection.
    // The runtime remains private until every physical schema passes.
    runtime = composeRuntime(
      { ...options, analytics: limits },
      model,
      bindings,
    );
    await bindings.describe();

    return runtime;
  } catch (error) {
    if (runtime) await runtime.close();
    else await bindings.retire();

    throw error;
  }
}

function composeRuntime<
  G extends GraphDefinition & { readonly objects: ObjectRegistry },
>(
  options: StartupOptions<G>,
  model: ReturnType<typeof compile<G>>,
  bindings: HostBindings,
): Relate<G> {
  // Keep every later facade aligned with this compiled model. Definitions are
  // immutable, but the graph and its caller-owned registries need not be.
  const description = model.consumer;
  const objects = Object.entries(options.graph.objects);
  const registered = new Set<ObjectDefinition>(
    objects.map(([, object]) => object),
  );
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
        idempotencyId: context.idempotencyId,
        actor: context.actor,
        input: context.input,
        fail: context.fail,
        objects: Object.fromEntries(
          objects.map(([name, object]) => [
            name,
            Object.freeze({
              query: (request: CollectionReadControls = {}) =>
                createPagedQuery(`${name}.query`, request, (page) =>
                  context.query(object.id, page),
                ),
              get: (id: string, request = {}) =>
                context.read(object.id, id, request),
              ...(implementation.action.creates.includes(object as never)
                ? {
                    create: (values: unknown) =>
                      context.create(object.id, values),
                  }
                : {}),
              ...(implementation.action.adopts?.includes(object as never)
                ? {
                    adopt: (sourceRecordId: string) =>
                      context.adopt(object.id, sourceRecordId),
                  }
                : {}),
            }),
          ]),
        ) as never,
      });
  }

  if (actions.some(([, action]) => !Object.hasOwn(handlers, action.id)))
    throw new Error('Missing action implementation');

  const analyticalLifetime = new AbortController();
  const engine = createEngine({
    ...(options.sqlParser
      ? {
          analytics: {
            parser: options.sqlParser,
            ...(options.analytics === undefined
              ? {}
              : { limits: options.analytics }),
            signal: analyticalLifetime.signal,
            binding: bindings.analyticalBinding,
          },
        }
      : {}),
    model,
    graphId: options.graphId ?? options.graph.id,
    sources: bindings.sources,
    actionHandlers: handlers,
    ...(options.actionTimeoutMs !== undefined
      ? { actionTimeoutMs: options.actionTimeoutMs }
      : {}),
    ...(options.store ? { store: options.store } : {}),
    ...(options.clock ? { clock: options.clock } : {}),
    ...(options.cursorKey ? { cursorKey: options.cursorKey } : {}),
    ...(options.activity ? { activity: options.activity } : {}),
  });
  const flushTimeoutMs = options.activity?.flushTimeoutMs ?? 5_000;

  if (!Number.isInteger(flushTimeoutMs) || flushTimeoutMs < 0)
    throw new Error('activity.flushTimeoutMs must be a non-negative integer');

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

  /** One typed engine binding for embedded calls and trusted transport dispatch. */
  function bindCalls(
    actor: Principal,
    scope: () => OperationScope,
  ): Omit<ConsumerOperations, 'discovery'> {
    return {
      get: (objectDefinitionId, objectId, options) =>
        run(() =>
          engine.read(actor, objectDefinitionId, objectId, options, scope()),
        ),
      query: (objectDefinitionId, options) =>
        run(() => engine.query(actor, objectDefinitionId, options, scope())),
      traverse: (objectDefinitionId, objectId, traversal, options) =>
        run(() =>
          engine.traverse(
            actor,
            objectDefinitionId,
            objectId,
            traversal,
            options,
            scope(),
          ),
        ),
      invoke: (actionDefinitionId, options) =>
        run(() => engine.invoke(actor, actionDefinitionId, options, scope())),
      getReceipt: (actionDefinitionId, invocationId) =>
        run(() =>
          engine.getReceipt(actor, actionDefinitionId, invocationId, scope()),
        ),
    };
  }

  /**
   * Bind one host-authenticated principal and request context; every call is
   * tracked for `close()`. The binding carries context, never an operation
   * ID: each call is its own attempt, and embedded callers without a request
   * ID get a fresh one per call.
   */
  function operations(
    principal: Principal,
    context?: Partial<OperationContext>,
  ): ConsumerOperations {
    open();

    // A handle binds a snapshot of the host-authenticated principal.
    const actor = structuredClone(principal);
    const request = context ? requestContext(context) : undefined;
    const scope = () =>
      createOperationScope({ kind: 'principal', id: actor.id }, request);
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
      ...bindCalls(actor, scope),
    };

    return Object.freeze(bound);
  }

  return {
    as(principal: Principal): Consumer<G> {
      // Compilation validated schema support; the engine validates values and selection.
      return createConsumer(description, operations(principal));
    },
    operations,
    host: Object.freeze({
      adopt: <
        O extends Extract<
          G['objects'][keyof G['objects']],
          { readonly membership: SourceMembership }
        >,
      >(
        object: O,
        sourceRecordId: string,
        adoption?: HostAttribution,
      ) =>
        run(async () => {
          if (!registered.has(object))
            throw new Error('Unregistered adoption target');

          const scope = createOperationScope(
            hostAttribution(adoption),
            adoption?.context ? requestContext(adoption.context) : undefined,
          );

          // Adoption establishes the canonical ID for this registered definition.
          return (await engine.adopt(
            object.id,
            sourceRecordId,
            scope,
          )) as ObjectId<O['id']>;
        }),
      activity: Object.freeze({
        status: () => run(() => engine.activity.status()),
        feed: Object.freeze({
          read: (options?: Parameters<typeof engine.activity.feed.read>[0]) =>
            run(() => engine.activity.feed.read(options)),
        }),
        operations: Object.freeze({
          list: (
            options?: Parameters<typeof engine.activity.operations.list>[0],
          ) => run(() => engine.activity.operations.list(options)),
        }),
      }),
      provenance: (object: ActivityObjectRef) =>
        run(() => engine.provenance(object)),
      activityCounters: () => engine.activityCounters(),
      flushActivity: () => engine.flushActivity(flushTimeoutMs),
      async dispatch(
        principal: Principal,
        attempt: HostDispatch,
        method: DispatchMethod,
        args: readonly unknown[],
      ): Promise<unknown> {
        open();

        if (!attempt || typeof attempt !== 'object' || !Array.isArray(args))
          throw new Error('Invalid dispatch');

        const actor = structuredClone(principal);
        // The bound principal is the actor; the caller supplies identity and context only.
        const scope = createOperationScope(
          { kind: 'principal', id: actor.id },
          attempt.context ? requestContext(attempt.context) : undefined,
          attempt.operationId,
        );
        const calls = bindCalls(actor, () => scope);

        if (typeof method !== 'string' || !Object.hasOwn(calls, method))
          throw new Error('Invalid dispatch method');

        // Only this trusted transport boundary accepts untyped arguments.
        // Engine methods validate them through the same binding as ordinary calls.
        return (calls[method] as (...input: unknown[]) => Promise<unknown>)(
          ...args,
        );
      },
    }),
    async close() {
      closed = true;
      analyticalLifetime.abort();
      let timer: ReturnType<typeof setTimeout> | undefined;

      try {
        await Promise.race([
          (async () => {
            await bindings.retire();
            await Promise.allSettled([...pending]);
          })(),
          new Promise<never>((_, reject) => {
            timer = setTimeout(
              () =>
                reject(
                  new Error(
                    'Runtime shutdown timed out while draining operations',
                  ),
                ),
              options.shutdownTimeoutMs ?? 5000,
            );
          }),
        ]);
      } finally {
        if (timer) clearTimeout(timer);
      }

      // Drain tracked operations first, then flush capture within a deadline.
      // Expiry reports abandoned rows; a borrowed store stays open either way.
      await engine.drainActivity(flushTimeoutMs);
    },
  };
}
