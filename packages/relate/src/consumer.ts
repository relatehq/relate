import { ActionError, ReadError } from '@relate/protocol';
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
    get<
      A extends (G extends {
        readonly actions: infer Actions extends Readonly<
          Record<string, ActionDefinition>
        >;
      }
        ? Actions[keyof Actions]
        : never),
    >(
      action: A,
      invocationId: string,
    ): Promise<Receipt<A>>;
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
 * Build the typed consumer facade of `graph` over actor-bound operations.
 *
 * The facade only routes: it maps registry names to definition IDs, adds the
 * canonical `id` to `get` results, pages queries and to-many traversals with
 * `createPagedQuery`, and decorates discovery with its own call paths. It does
 * not validate requests, authorize, or cache results; the operations do. It is
 * browser safe and imports neither the compiler nor the engine, so an embedded
 * host and a remote client share one facade over different operations.
 */
export function createConsumer<G extends ConsumerGraph>(
  graph: G,
  operations: ConsumerOperations,
): Consumer<G> {
  const objects = Object.entries(graph.objects);
  const actions = Object.entries(graph.actions ?? {});
  const apiNames = new Map(
    objects.map(([name, object]) => [object.id, name] as const),
  );
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
  const traversalsOf = (object: ObjectDefinition) =>
    Object.values(graph.relationships ?? {}).flatMap((relationship) => [
      ...(relationship.from.id === object.id
        ? [
            {
              traversal: relationship.forward,
              target: apiNames.get(relationship.to.id),
            },
          ]
        : []),
      ...(relationship.to.id === object.id
        ? [
            {
              traversal: relationship.reverse,
              target: apiNames.get(relationship.from.id),
            },
          ]
        : []),
    ]);

  const objectOperations = Object.fromEntries(
    objects.map(([name, object]) => {
      const path = `objects.${name}`;
      let source: ProtocolObjectDescription | undefined;
      let described: ObjectDescription | undefined;

      return [
        name,
        Object.freeze({
          // Ask discovery every time so it keeps its own availability rules;
          // decorate once per distinct (memoized) detail it returns.
          describe: () => {
            const detail = discovery.describeObject(object.id);

            if (detail !== source || described === undefined) {
              source = detail;
              described = withCalls(path, detail);
            }

            return described;
          },
          traverse: Object.freeze(
            Object.fromEntries(
              traversalsOf(object).map(({ traversal, target }) => {
                const operation = `${name}.traverse.${traversal.name}`;
                const signature = () =>
                  traversal.cardinality === 'one'
                    ? `${path}.traverse.${traversal.name}(id: ObjectId<${name}>, options?: ${optionText((c) => c.traverse.one.options)}): Promise<ObjectResult<${target}>>`
                    : `${path}.traverse.${traversal.name}(id: ObjectId<${name}>, options?: ${optionText((c) => c.traverse.many.options)}): QueryResult<${target}>`;

                return [
                  traversal.name,
                  documented((id: string, request: TraversalRequest = {}) => {
                    if (traversal.cardinality === 'one')
                      return (async () => {
                        const result = await operations.traverse(
                          object.id,
                          id,
                          traversal.name,
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
                          object.id,
                          id,
                          traversal.name,
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
                operations.query(object.id, page),
              ),
            () =>
              `${path}.query(options?: ${optionText((c) => c.query.options)}): QueryResult<${name}>`,
          ),
          get: documented(
            async (id: string, request = {}) => {
              const result = await operations.read(object.id, id, request);

              return result.status === 'ok' ? { ...result, id } : result;
            },
            () =>
              `${path}.get(id: ObjectId<${name}>, options?: ${optionText((c) => c.get.options)}): Promise<ObjectResult<${name}>>`,
          ),
        }),
      ];
    }),
  );

  // The registry gives each operation exactly the definition the host compiled;
  // the operations validate values and selection against that model.
  return Object.freeze({
    describe: () => discovery.describe(),
    objects: Object.freeze(objectOperations),
    receipts: Object.freeze({
      get: async (action: ActionDefinition, invocationId: string) => {
        if (!actions.some(([, registered]) => registered === action))
          throw new ActionError('denied');

        return operations.getReceipt(action.id, invocationId);
      },
    }),
    actions: Object.freeze(
      Object.fromEntries(
        actions.map(([name, action]) => {
          const invoke = (request: {
            readonly input: Json;
            readonly idempotencyKey: string;
          }) => operations.invoke(action.id, request);

          Object.defineProperty(invoke, 'describe', {
            value: () => discovery.describeAction(action.id),
            enumerable: true,
          });

          return [name, Object.freeze(invoke)];
        }),
      ),
    ),
  }) as unknown as Consumer<G>;
}
