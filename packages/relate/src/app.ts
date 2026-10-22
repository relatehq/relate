import { portable } from './portable-schema.js';
import type { AnalyticalLimits } from './analytics/limits.js';
import type { DatasetDefinition } from './datasets.js';
import type { ActionDefinition, ActionImplementation } from './actions.js';
import type {
  GraphDefinition,
  ObjectRegistry,
  SourceDefinition,
} from './index.js';
import type {
  SourceBinding,
  SourceResource,
  SourceConnector,
  ApplicationSourceConnector,
  ResourceConnection,
  AnalyticalConnection,
  AnalyticalResource,
  DatasetResource,
} from './connectors.js';
import type { ActivityCaptureOptions, ObservationStore } from './storage.js';

type Graph = GraphDefinition & { readonly objects: ObjectRegistry };

export type SourceAppBinding = SourceBinding & {
  readonly source: SourceDefinition;
  /** Original connection identity, shared by every selected resource. */
  readonly connection?: ResourceConnection;
};

export interface DatasetBinding {
  readonly dataset: DatasetDefinition;
  readonly connection: AnalyticalConnection;
  readonly connectionId: string;
  readonly resourceId: string;
  readonly resource: DatasetResource;
  readonly columns: Readonly<Record<string, string>>;
}

export type Binding = SourceAppBinding | DatasetBinding;

type BindingOptions<T = SourceBinding> = T extends SourceBinding
  ? Omit<T, 'authorization'> & {
      readonly authorization?: 'shared-service';
      readonly connection?: ResourceConnection;
    }
  : never;

function isDataset(
  source: SourceDefinition | DatasetDefinition,
): source is DatasetDefinition {
  return 'kind' in source && source.kind === 'dataset';
}

/** Bind a dataset to a selected analytical resource; unspecified columns retain their names. */
export function bind<
  const D extends DatasetDefinition,
  const C extends Readonly<Record<string, unknown>> = {},
>(
  dataset: D,
  resource: AnalyticalResource,
  options?: {
    readonly columns?: C & { readonly [K in keyof C]-?: string } & Record<
        Exclude<keyof C, Extract<keyof NoInfer<D>['columns'], string>>,
        never
      >;
  },
): DatasetBinding;

/** Custom adapters may supply the explicit resource identity and keyed reader. */
export function bind(
  source: SourceDefinition,
  resource: BindingOptions,
): SourceAppBinding;

/** Bind a source contract to a selected resource without opening it. */
export function bind(
  source: SourceDefinition,
  resource: SourceResource<ApplicationSourceConnector>,
  options?: {
    readonly authorization?: 'shared-service';
    readonly providerAccountId?: never;
  },
): SourceAppBinding;

export function bind(
  source: SourceDefinition,
  resource: SourceResource<SourceConnector>,
  options: {
    readonly authorization?: 'shared-service';
    readonly providerAccountId: string;
  },
): SourceAppBinding;

export function bind(
  source: SourceDefinition | DatasetDefinition,
  resource: SourceResource | AnalyticalResource | BindingOptions,
  options?: {
    readonly authorization?: 'shared-service';
    readonly providerAccountId?: string;
    readonly columns?: Readonly<Record<string, string | undefined>>;
  },
): Binding {
  if (isDataset(source)) {
    if (
      !resource ||
      typeof resource !== 'object' ||
      !('bindDataset' in resource) ||
      typeof resource.bindDataset !== 'function'
    )
      throw new Error('Dataset binding requires an analytical resource');

    if (
      options &&
      (Object.keys(options).some((key) => key !== 'columns') ||
        (options.columns !== undefined &&
          (!options.columns ||
            typeof options.columns !== 'object' ||
            Array.isArray(options.columns))))
    )
      throw new Error('Dataset binding accepts only a column mapping');

    const overrides = options?.columns ?? {};

    if (
      Object.keys(overrides).some(
        (name) => !Object.hasOwn(source.columns, name),
      )
    )
      throw new Error('Unknown declared dataset column in binding');

    const columns = Object.freeze(
      Object.fromEntries(
        Object.keys(source.columns).map((name) => {
          const physical = Object.hasOwn(overrides, name)
            ? overrides[name]
            : name;

          if (
            typeof physical !== 'string' ||
            !physical.trim() ||
            physical.includes('\0')
          )
            throw new Error(
              'Dataset physical columns must be nonempty identifiers',
            );

          return [name, physical];
        }),
      ),
    );

    return Object.freeze({
      dataset: source,
      connection: resource.connection,
      connectionId: resource.connection.connectionId,
      resourceId: resource.resourceId,
      columns,
      resource: resource.bindDataset({ columns }),
    });
  }

  if ('bindDataset' in resource && !('bindSource' in resource))
    throw new Error('Source binding requires a keyed resource');

  const keyed = resource as SourceResource | BindingOptions;
  const binding =
    'bindSource' in keyed
      ? {
          connectionId: keyed.connection.connectionId,
          connection: keyed.connection,
          resourceId: keyed.resourceId,
          connector: keyed.bindSource({
            idField: source.idField,
            fields: Object.keys(source.schema.shape),
            schemas: Object.fromEntries(
              Object.entries(source.schema.shape).map(([name, schema]) => [
                name,
                portable(schema),
              ]),
            ),
          }),
          ...options,
        }
      : keyed;

  return Object.freeze({
    ...binding,
    source,
    authorization: binding.authorization ?? 'shared-service',
  }) as SourceAppBinding;
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
  readonly bindings: readonly Binding[];
  readonly graphId?: string;
  /** Borrowed storage: the caller owns migrations and closing it. */
  readonly store?: ObservationStore;
  readonly clock?: () => number;
  readonly actionTimeoutMs?: number;
  /** Maximum operation drain before close rejects and app disposers run. Default 5 seconds. */
  readonly shutdownTimeoutMs?: number;
  /** Host-owned analytical preparation, execution and admission limits; callers may only tighten deadlines. */
  readonly analytics?: AnalyticalLimits;
  readonly cursorKey?: Uint8Array;
  /** Operation capture; the feed and object provenance are always recorded. */
  readonly activity?: ActivityCaptureOptions;
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
