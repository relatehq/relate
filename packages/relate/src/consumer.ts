import { ActionError, ReadError } from '@relate/protocol';
import { captureConsumerDescription } from './consumer-description.js';
import type { ConsumerRoutingDescription } from './consumer-description.js';
import type {
  ActionDescription,
  ConsumerOperations,
  EvidenceMode,
  GraphDescription,
  Json,
  ObjectDescription as ProtocolObjectDescription,
  Page as ResultPage,
  QueryRequest,
  QueryResult,
  RequestIssue,
  TraversalDescription as ProtocolTraversalDescription,
  TraversalRequest,
} from '@relate/protocol';
import type {
  ActionDefinition,
  ActionRequest,
  GraphDefinition,
  ObjectDefinition,
  ObjectId,
  ObjectRegistry,
  PropertyNames,
  Receipt,
  RelationshipDefinition,
  RelationshipRegistry,
} from './index.js';
import type {
  ObjectRecord,
  ObjectResult,
  PageOptions,
  QueryOptions,
  ReadOptions,
} from './operations.js';

export type {
  ObjectRecord,
  ObjectResult,
  PageOptions,
  QueryOptions,
  QueryResult,
  ReadOptions,
} from './operations.js';

// Pagination

/** The same issue the engine reports for an undecodable cursor. */
function cursorIssue(): RequestIssue {
  return {
    path: ['cursor'],
    problem: 'invalid-cursor',
    message:
      'not valid for this call. Pass page.meta.continuationCursor from a page of this same operation with the same options; cursors expire.',
  };
}

/** Validate the envelope, not records: the page reader owns policy and evidence. */
function validatePage<T>(
  page: ResultPage<T>,
  cursor: string | undefined,
): void {
  if (
    !page ||
    !Array.isArray(page.data) ||
    !page.meta ||
    typeof page.meta !== 'object'
  )
    throw new ReadError('incomplete');

  const meta = page.meta;

  if (meta.exhausted === true) {
    if ('continuationCursor' in meta) throw new ReadError('incomplete');
  } else if (
    meta.exhausted !== false ||
    typeof meta.continuationCursor !== 'string' ||
    meta.continuationCursor.length === 0 ||
    meta.continuationCursor === cursor
  )
    throw new ReadError('incomplete');
}

/**
 * Wrap an authorized page reader for queries or to-many traversals.
 *
 * The reader captures immutable query options and the caller/transaction context;
 * this helper supplies only the changing cursor. The reader must enforce actual
 * scan progress, cursor scope, ordering and operation budgets. Opaque token
 * inequality alone cannot prove progress or snapshot consistency.
 *
 * Execution is lazy. All awaits and iterators on this handle share the first
 * page request (including failure). Each iterator has its own continuation state
 * and fetches subsequent pages on demand. Reiteration can refetch later pages;
 * this is not a materialized snapshot. No page is prefetched, so break/throw
 * stops further requests. Records and their evidence pass through unchanged.
 *
 * Malformed continuations and cycles throw ReadError('incomplete') before that
 * page's records are exposed. Reader failures propagate to the caller. The helper
 * neither commits nor retries: action transaction ownership stays with its caller.
 */
export function createQuery<T>(
  readPage: (cursor: string | undefined) => Promise<ResultPage<T>>,
  options: { readonly cursor?: string; readonly operation?: string } = {},
): QueryResult<T> {
  const initialCursor = options.cursor;

  if (
    initialCursor !== undefined &&
    (typeof initialCursor !== 'string' || initialCursor.length === 0)
  )
    throw new ReadError('invalid-request', {
      operation: options.operation ?? 'query',
      issues: [cursorIssue()],
    });

  const fetchPage = async (
    cursor: string | undefined,
  ): Promise<ResultPage<T>> => {
    const page = await readPage(cursor);

    validatePage(page, cursor);

    return page;
  };
  let firstPage: Promise<ResultPage<T>> | undefined;
  const first = () => (firstPage ??= fetchPage(initialCursor));

  return {
    then(onfulfilled, onrejected) {
      return first().then(onfulfilled, onrejected);
    },
    async *[Symbol.asyncIterator]() {
      const seen = new Set<string>();

      if (initialCursor !== undefined) seen.add(initialCursor);

      let page = await first();

      while (true) {
        const nextCursor = page.meta.exhausted
          ? undefined
          : page.meta.continuationCursor;

        if (nextCursor !== undefined) {
          if (seen.has(nextCursor)) throw new ReadError('incomplete');

          seen.add(nextCursor);
        }

        yield* page.data;

        if (nextCursor === undefined) return;

        page = await fetchPage(nextCursor);
      }
    },
  };
}

/**
 * Bind a caller's paged request once and page through it with `createQuery`.
 *
 * The request is captured as plain data before the first page is read, so
 * later mutation by the caller cannot change which pages the handle fetches.
 * Options that are not plain data reject the handle with
 * `ReadError('invalid-request')`, like any other request error, instead of
 * throwing synchronously. `request.cursor` resumes an earlier page sequence.
 */
export function createPagedQuery<R extends { readonly cursor?: string }, T>(
  operation: string,
  request: R,
  readPage: (request: R) => Promise<ResultPage<T>>,
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

// Typed consumer contract

/** A traversal with this facade's call path, e.g. `objects.Playlist.traverse.songs(id, options?)`. */
export interface TraversalDescription extends ProtocolTraversalDescription {
  readonly call: string;
}

/** Object detail with this facade's call paths for get, query and each traversal. */
export interface ObjectDescription extends Omit<
  ProtocolObjectDescription,
  'operations' | 'traversals'
> {
  readonly operations: {
    readonly get: ProtocolObjectDescription['operations']['get'] & {
      readonly call: string;
    };
    readonly query: ProtocolObjectDescription['operations']['query'] & {
      readonly call: string;
    };
  };
  readonly traversals: readonly TraversalDescription[];
}

export type Page<
  O extends ObjectDefinition,
  K extends PropertyNames<O> = PropertyNames<O>,
> = ResultPage<ObjectRecord<O, K>>;

type Edge<R extends RelationshipDefinition, O extends ObjectDefinition> =
  | (R['from']['id'] extends O['id']
      ? { traversal: R['forward']; target: R['to'] }
      : never)
  | (R['to']['id'] extends O['id']
      ? { traversal: R['reverse']; target: R['from'] }
      : never);

type Edges<R extends RelationshipRegistry, O extends ObjectDefinition> = {
  [K in keyof R]: Edge<R[K], O>;
}[keyof R];

type Traversals<R extends RelationshipRegistry, O extends ObjectDefinition> = {
  readonly [E in Edges<R, O> as E['traversal']['name']]: {
    <K extends PropertyNames<E['target']> = PropertyNames<E['target']>>(
      id: ObjectId<O['id']>,
      options: (E['traversal']['cardinality'] extends 'many'
        ? PageOptions<K, 'full'>
        : ReadOptions<K, 'full'>) & { readonly evidence: 'full' },
    ): E['traversal']['cardinality'] extends 'many'
      ? QueryResult<ObjectRecord<E['target'], K, 'full'>>
      : Promise<ObjectResult<E['target'], K, 'full'>>;
    <
      K extends PropertyNames<E['target']> = PropertyNames<E['target']>,
      M extends EvidenceMode = 'compact',
    >(
      id: ObjectId<O['id']>,
      options?: E['traversal']['cardinality'] extends 'many'
        ? PageOptions<K, M>
        : ReadOptions<K, M>,
    ): E['traversal']['cardinality'] extends 'many'
      ? QueryResult<ObjectRecord<E['target'], K, M | 'compact'>>
      : Promise<ObjectResult<E['target'], K, M | 'compact'>>;
  };
};

export interface ObjectOperations<
  O extends ObjectDefinition,
  R extends RelationshipRegistry = {},
> {
  describe(): ObjectDescription | undefined;
  readonly traverse: Traversals<R, O>;
  query<K extends PropertyNames<O> = PropertyNames<O>>(
    options: QueryOptions<O, K, 'full'> & { readonly evidence: 'full' },
  ): QueryResult<ObjectRecord<O, K, 'full'>>;
  query<
    K extends PropertyNames<O> = PropertyNames<O>,
    E extends EvidenceMode = 'compact',
  >(
    options?: QueryOptions<O, K, E>,
  ): QueryResult<ObjectRecord<O, K, E | 'compact'>>;
  get<K extends PropertyNames<O> = PropertyNames<O>>(
    id: ObjectId<O['id']>,
    options: ReadOptions<K, 'full'> & { readonly evidence: 'full' },
  ): Promise<ObjectResult<O, K, 'full'>>;
  get<
    K extends PropertyNames<O> = PropertyNames<O>,
    E extends EvidenceMode = 'compact',
  >(
    id: ObjectId<O['id']>,
    options?: ReadOptions<K, E>,
  ): Promise<ObjectResult<O, K, E | 'compact'>>;
}

export type ActionOperations<A extends ActionDefinition> = {
  (request: ActionRequest<A>): Promise<Receipt<A>>;
  describe(): ActionDescription | undefined;
};

type ConsumerGraph = GraphDefinition & { readonly objects: ObjectRegistry };

declare const consumerGraph: unique symbol;

type GraphActions<G extends ConsumerGraph> = G extends {
  readonly actions: infer A extends Readonly<Record<string, ActionDefinition>>;
}
  ? A
  : {};

type GraphRelationships<G extends ConsumerGraph> = G extends {
  readonly relationships: infer R extends RelationshipRegistry;
}
  ? R
  : {};

type RegistryName<G extends ConsumerGraph, O extends ObjectDefinition> = {
  [N in keyof G['objects']]: G['objects'][N]['id'] extends O['id'] ? N : never;
}[keyof G['objects']];

type ActionAt<
  G extends ConsumerGraph,
  N extends keyof GraphActions<G>,
> = Extract<GraphActions<G>[N], ActionDefinition>;

type TraversalRoutes<
  G extends ConsumerGraph,
  R extends RelationshipRegistry,
  O extends ObjectDefinition,
> = {
  readonly [E in Edges<R, O> as E['traversal']['name']]: {
    readonly cardinality: E['traversal']['cardinality'];
    readonly target: RegistryName<G, E['target']>;
  };
};

/**
 * Versioned, actor-independent routing exported by `compile(graph).consumer`.
 * Generated clients ship this JSON beside type declarations, without schemas or
 * policies. The mapped keys and IDs keep hand-authored artifacts honest too.
 */
export type ConsumerDescription<G extends ConsumerGraph = ConsumerGraph> = Omit<
  ConsumerRoutingDescription,
  'objects' | 'actions'
> & {
  readonly graphDefinitionId: G['id'];
  readonly objects: {
    readonly [N in keyof G['objects']]: {
      readonly definitionId: G['objects'][N]['id'];
      readonly traversals: TraversalRoutes<
        G,
        GraphRelationships<G>,
        G['objects'][N]
      >;
    };
  };
  readonly actions: {
    readonly [N in keyof GraphActions<G>]: {
      readonly definitionId: ActionAt<G, N>['id'];
    };
  };
  /** Retains graph inference through the compiler-produced artifact. */
  readonly [consumerGraph]?: G;
};

/**
 * The typed, actor-bound consumer API of one graph: `objects.Customer.get`,
 * `objects.Customer.query`, `objects.Customer.traverse.invoices`,
 * `actions.addAccountReview`, progressive `describe()` and receipt lookup.
 * Names and types are inferred from the authored graph; every call is carried
 * out by the `ConsumerOperations` the facade was created with.
 */
export interface Consumer<G extends ConsumerGraph> {
  describe(): GraphDescription;
  readonly receipts: {
    get<N extends keyof GraphActions<G> & string>(
      action: N,
      invocationId: string,
    ): Promise<Receipt<ActionAt<G, N>>>;
  };
  readonly actions: G extends {
    readonly actions: infer A extends Readonly<
      Record<string, ActionDefinition>
    >;
  }
    ? {
        readonly [K in keyof A]: ActionOperations<A[K]>;
      }
    : {};
  readonly objects: {
    readonly [N in keyof G['objects']]: ObjectOperations<
      G['objects'][N],
      G extends { readonly relationships: infer R extends RelationshipRegistry }
        ? R
        : {}
    >;
  };
}

// Facade construction

const inspect = Symbol.for('nodejs.util.inspect.custom');

/**
 * Printing an operation shows how to call it rather than its implementation, so
 * a REPL or log teaches the same contract discovery describes.
 */
function documented<F extends (...args: never[]) => unknown>(
  operation: F,
  signature: () => string,
): F {
  for (const key of ['toString', inspect])
    Object.defineProperty(operation, key, { value: signature });

  return operation;
}

const optionNames = (options: readonly string[]) =>
  `{ ${options.map((option) => `${option}?`).join(', ')} }`;

/** Add this facade's call paths to the surface-neutral object detail. */
function withCalls(
  path: string,
  description: ProtocolObjectDescription | undefined,
): ObjectDescription | undefined {
  if (!description) return undefined;

  // Discovery detail is already frozen; freeze only the members added here.
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

/**
 * Build the typed consumer facade over actor-bound operations.
 *
 * The facade accepts the versioned description exported by the compiler. It
 * checks model compatibility at binding and captures routing. It maps
 * registry names to definition IDs, pages queries and to-many traversals with
 * `createPagedQuery`, checks that traversal results match their cardinality,
 * and decorates discovery with its own call paths. It does not validate
 * requests, authorize, or cache results; the operations do. It is browser safe
 * and imports neither the compiler nor the engine, so an embedded host and a
 * remote client share one facade over different operations.
 */
export function createConsumer<G extends ConsumerGraph>(
  source: ConsumerDescription<G>,
  operations: ConsumerOperations,
): Consumer<G> {
  const description = captureConsumerDescription(source);
  const actual = operations.discovery.describe();

  if (
    actual.definitionId !== description.graphDefinitionId ||
    actual.definitionRevision !== description.definitionRevision
  )
    throw new Error('Consumer description does not match the operations model');

  const objects = Object.entries(description.objects);
  const actions = Object.entries(description.actions);
  const { discovery } = operations;
  // Option names come from the actor's discovery snapshot; printing an operation
  // must not fail when that snapshot is unavailable (for example after close).
  const contract = <T>(
    select: (contracts: GraphDescription['operations']) => T,
  ) => {
    try {
      return select(discovery.describe().operations);
    } catch {
      return undefined;
    }
  };
  const optionText = (
    select: (contracts: GraphDescription['operations']) => readonly string[],
  ) => {
    const options = contract(select);

    return options ? optionNames(options) : '{ … }';
  };

  const objectOperations = Object.fromEntries(
    objects.map(([name, { definitionId, traversals }]) => {
      const path = `objects.${name}`;
      let source: ProtocolObjectDescription | undefined;
      let described: ObjectDescription | undefined;

      return [
        name,
        Object.freeze({
          // Ask discovery every time so it keeps its own availability rules;
          // decorate once per distinct (memoized) detail it returns.
          describe: () => {
            const detail = discovery.describeObject(definitionId);

            if (detail !== source || described === undefined) {
              source = detail;
              described = withCalls(path, detail);
            }

            return described;
          },
          traverse: Object.freeze(
            Object.fromEntries(
              Object.entries(traversals).map(([traversal, edge]) => {
                const operation = `${name}.traverse.${traversal}`;
                const signature = () =>
                  edge.cardinality === 'one'
                    ? `${path}.traverse.${traversal}(id: ObjectId<${name}>, options?: ${optionText((c) => c.traverse.one.options)}): Promise<ObjectResult<${edge.target}>>`
                    : `${path}.traverse.${traversal}(id: ObjectId<${name}>, options?: ${optionText((c) => c.traverse.many.options)}): QueryResult<${edge.target}>`;

                return [
                  traversal,
                  documented((id: string, request: TraversalRequest = {}) => {
                    if (edge.cardinality === 'one')
                      return (async () => {
                        const result = await operations.traverse(
                          definitionId,
                          id,
                          traversal,
                          request,
                        );

                        if (!('status' in result))
                          throw new Error('Invalid to-one traversal result');

                        return result;
                      })();

                    return createPagedQuery(
                      operation,
                      request,
                      async (page) => {
                        const result = await operations.traverse(
                          definitionId,
                          id,
                          traversal,
                          page,
                        );

                        if ('status' in result)
                          throw new Error('Invalid to-many traversal result');

                        return result;
                      },
                    );
                  }, signature),
                ];
              }),
            ),
          ),
          query: documented(
            (request: QueryRequest = {}) =>
              createPagedQuery(`${name}.query`, request, (page) =>
                operations.query(definitionId, page),
              ),
            () =>
              `${path}.query(options?: ${optionText((c) => c.query.options)}): QueryResult<${name}>`,
          ),
          get: documented(
            async (id: string, request = {}) =>
              operations.get(definitionId, id, request),
            () =>
              `${path}.get(id: ObjectId<${name}>, options?: ${optionText((c) => c.get.options)}): Promise<ObjectResult<${name}>>`,
          ),
        }),
      ];
    }),
  );

  const actionIds = new Map(
    actions.map(([name, action]) => [name, action.definitionId]),
  );

  // The description names exactly the definitions the host compiled; the
  // operations validate values and selection against that model.
  return Object.freeze({
    describe: () => discovery.describe(),
    objects: Object.freeze(objectOperations),
    receipts: Object.freeze({
      get: async (action: string, invocationId: string) => {
        const id = actionIds.get(action);

        if (id === undefined) throw new ActionError('denied');

        return operations.getReceipt(id, invocationId);
      },
    }),
    actions: Object.freeze(
      Object.fromEntries(
        actions.map(([name, { definitionId }]) => {
          const invoke = async (request: {
            readonly input: Json;
            readonly idempotencyKey: string;
          }) => operations.invoke(definitionId, request);

          Object.defineProperty(invoke, 'describe', {
            value: () => discovery.describeAction(definitionId),
            enumerable: true,
          });

          return [name, Object.freeze(invoke)];
        }),
      ),
    ),
  }) as unknown as Consumer<G>;
}
