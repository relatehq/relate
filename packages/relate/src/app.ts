import type { ActionDefinition, ActionImplementation } from './actions.js';
import type {
  GraphDefinition,
  ObjectRegistry,
  SourceDefinition,
} from './index.js';
import type { SourceBinding } from './connectors.js';
import type { ObservationStore } from './storage.js';

type Graph = GraphDefinition & { readonly objects: ObjectRegistry };

export type Connection = SourceBinding & { readonly source: SourceDefinition };

type ConnectionOptions<T = SourceBinding> = T extends SourceBinding
  ? Omit<T, 'authorization'> & { readonly authorization?: 'shared-service' }
  : never;

/** This slice supports shared service credentials only. Credentials stay in the connector. */
export function connect(
  source: SourceDefinition,
  binding: ConnectionOptions,
): Connection {
  return Object.freeze({
    ...binding,
    source,
    authorization: binding.authorization ?? 'shared-service',
  });
}

export interface AppBindings<
  G extends GraphDefinition & { readonly objects: ObjectRegistry },
> {
  readonly actionImplementations?: readonly (G extends {
    readonly actions: infer A extends Readonly<
      Record<string, ActionDefinition>
    >;
  }
    ? { [K in keyof A]: ActionImplementation<G, A[K]> }[keyof A]
    : never)[];
  readonly connections: readonly Connection[];
  readonly graphId?: string;
  /** Borrowed storage: the caller owns migrations and closing it. */
  readonly store?: ObservationStore;
  readonly clock?: () => number;
  readonly actionTimeoutMs?: number;
  readonly cursorKey?: Uint8Array;
}

export interface AppSetupContext {
  /** Register cleanup for a resource opened during setup. Runs in reverse order. */
  onDispose(dispose: () => void | Promise<void>): void;
}

/**
 * A portable application descriptor: the authored graph plus a deferred recipe
 * for runtime bindings. Importing or creating it starts nothing.
 */
export interface AppDefinition<G extends Graph = Graph> {
  readonly kind: 'relate.app';
  readonly graph: G;
  readonly setup?: (
    context: AppSetupContext,
  ) => AppBindings<G> | Promise<AppBindings<G>>;
}

export function defineApp<const G extends Graph>(definition: {
  readonly graph: G;
  readonly setup?: (
    context: AppSetupContext,
  ) => AppBindings<G> | Promise<AppBindings<G>>;
}): AppDefinition<G> {
  if (!definition || typeof definition !== 'object' || !definition.graph)
    throw new Error('defineApp requires a graph');

  if (definition.setup !== undefined && typeof definition.setup !== 'function')
    throw new Error('defineApp setup must be a function');

  return Object.freeze({
    kind: 'relate.app',
    graph: definition.graph,
    ...(definition.setup ? { setup: definition.setup } : {}),
  });
}

/** Structural check that survives bundling and separate module instances. */
export function isAppDefinition(value: unknown): value is AppDefinition {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { kind?: unknown }).kind === 'relate.app' &&
    typeof (value as { graph?: unknown }).graph === 'object' &&
    (value as { graph: unknown }).graph !== null
  );
}
