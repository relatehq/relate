/**
 * The intended public surface, as declarations only. Nothing here executes.
 *
 * Helpers that already behave as intended are re-exported from `relate`.
 * Every `declare` below is work the packages still owe; when one is
 * implemented, replace its declaration with a re-export. The fixture is done
 * when this file is empty and the scenario runs.
 */
import type { z } from 'zod';
import type {
  Claim,
  Equality,
  FieldGroup,
  FieldReference,
  Property,
  RoleGate,
  defineAccess as currentDefineAccess,
  source,
} from 'relate';
import type { FieldEvidence, ReadRequest, ReadResult } from '@relate/protocol';
import type { ObservationStore } from '@relate/runtime/storage';

export { defineSource, equals, from, objectId, source } from 'relate';

// Definitions

type Options<Id extends string> = { id: Id; access: FieldGroup };

type NativeOrigin = { readonly origin: { readonly kind: 'native' } };

/** As today, but the origin stays visible to types so writes can be checked. */
export declare function native<S extends z.ZodType, const Id extends string>(
  schema: S,
  options: Options<Id>,
): Property<S> & NativeOrigin & { readonly id: Id };

export interface ReferenceProperty<
  Target extends string = string,
> extends Property<z.ZodString> {
  /** The referenced object definition's `id`. Values are its object IDs. */
  readonly references: Target;
}

/**
 * A typed reference to another object. Without `from`, Relate owns the value.
 * With `from`, the source field holds the target's source record ID, which is
 * resolved to its object ID; an unresolved reference is never adopted.
 */
export declare function reference<
  T extends ObjectDefinition,
  const Id extends string,
>(
  target: T,
  options: Options<Id> & { from: FieldReference<z.ZodString> },
): ReferenceProperty<T['id']> & { readonly id: Id };

export declare function reference<
  T extends ObjectDefinition,
  const Id extends string,
>(
  target: T,
  options: Options<Id>,
): ReferenceProperty<T['id']> & NativeOrigin & { readonly id: Id };

export interface NativeMembership {
  readonly kind: 'native';
}

export type SourceMembership = ReturnType<typeof source>;

/** Records exist because an action created them, not because a source has them. */
export declare function nativeMembership(): NativeMembership;

export interface ObjectDefinition<
  Id extends string = string,
  P extends Record<string, Property> = Record<string, Property>,
  M extends SourceMembership | NativeMembership =
    SourceMembership | NativeMembership,
> {
  readonly id: Id;
  readonly name: string;
  readonly membership: M;
  readonly properties: P;
}

export declare function defineObject<
  const Id extends string,
  const P extends Record<string, Property>,
  M extends SourceMembership | NativeMembership,
>(definition: {
  id: Id;
  name: string;
  membership: M;
  properties: P;
}): ObjectDefinition<Id, P, M>;

export interface Traversal {
  readonly name: string;
  readonly cardinality: 'one' | 'many';
}

export interface RelationshipDefinition<
  From extends ObjectDefinition = ObjectDefinition,
  To extends ObjectDefinition = ObjectDefinition,
  Forward extends Traversal = Traversal,
  Reverse extends Traversal = Traversal,
> {
  readonly id: string;
  readonly from: From;
  readonly to: To;
  readonly forward: Forward;
  readonly reverse: Reverse;
  readonly via: ReferenceProperty<From['id']>;
}

type Properties<O extends ObjectDefinition> =
  O['properties'][keyof O['properties']];

/** Declared outside both objects; owns both traversal names. */
export declare function defineRelationship<
  From extends ObjectDefinition,
  To extends ObjectDefinition,
  const Forward extends Traversal,
  const Reverse extends Traversal,
>(definition: {
  id: string;
  from: From;
  to: To;
  forward: Forward;
  reverse: Reverse;
  /** A reference on `to` that points at `from`. */
  via: Extract<Properties<NoInfer<To>>, ReferenceProperty<NoInfer<From>['id']>>;
}): RelationshipDefinition<From, To, Forward, Reverse>;

type NativeObject = ObjectDefinition<
  string,
  Record<string, Property>,
  NativeMembership
>;

type Reads<Target extends ObjectDefinition = ObjectDefinition> = Record<
  string,
  RelationshipDefinition<Target>
>;

export interface ActionDefinition<
  Target extends ObjectDefinition = ObjectDefinition,
  Input extends z.ZodType = z.ZodType,
  Output extends z.ZodType = z.ZodType,
  Creates extends readonly NativeObject[] = readonly NativeObject[],
  R extends Reads = Reads,
> {
  readonly id: string;
  readonly target: Target;
  readonly input: Input;
  readonly output: Output;
  readonly creates: Creates;
  readonly reads: R;
  /** Omission denies discovery and execution; graph assembly cannot override. */
  readonly policy?: ActionPolicy;
}

/** The serializable contract. Its implementation is supplied separately, server-side. */
export declare function defineAction<
  const Id extends string,
  Target extends ObjectDefinition,
  Input extends z.ZodType,
  Output extends z.ZodType,
  const Creates extends readonly NativeObject[],
  const R extends Reads<NoInfer<Target>> = {},
>(definition: {
  id: Id;
  target: Target;
  input: Input;
  output: Output;
  creates: Creates;
  /**
   * Relationships from the target whose records the implementation needs. They are
   * read as the actor before the implementation runs; nothing else is readable.
   */
  reads?: R;
  /** Declarative execution permission, colocated with the action contract. */
  policy?: ActionPolicy;
}): ActionDefinition<Target, Input, Output, Creates, R> & { readonly id: Id };

// Access

export interface Policy {
  readonly kind: 'object-policy';
}

export interface ActionPolicy {
  readonly execute: RoleGate;
}

type CurrentAccess<
  R extends readonly string[],
  G extends readonly string[],
  C extends Record<string, z.ZodType>,
> = ReturnType<typeof currentDefineAccess<R, G, C>>;

/**
 * As today, except: policies accept natively owned objects, the evidence
 * window is only stated alongside the predicate it limits, and actions are
 * denied until an action policy allows them.
 */
export declare function defineAccess<
  const R extends readonly string[],
  const G extends readonly string[],
  C extends Record<string, z.ZodType>,
>(definition: {
  roles: R;
  fieldGroups: G;
  claims: C;
}): Omit<CurrentAccess<R, G, C>, 'policy'> & {
  policy<O extends ObjectDefinition>(
    object: O,
    rules: {
      read:
        | { gate: RoleGate<R[number]> }
        | {
            gate: RoleGate<R[number]>;
            where: Equality<Properties<NoInfer<O>>>;
            evidenceMaxAgeMs: number;
          };
      groups?: Partial<
        Record<Exclude<G[number], 'ordinary'>, RoleGate<R[number]>>
      > & { ordinary?: never };
    },
  ): Policy;
};

interface AccessVocabulary {
  readonly roles: readonly string[];
  readonly claims: Readonly<Record<string, Claim>>;
  readonly fieldGroups: readonly string[];
}

/** What a host must supply after authenticating a caller. */
export type Principal<A extends AccessVocabulary = AccessVocabulary> = {
  readonly id: string;
  readonly roles: readonly A['roles'][number][];
  readonly claims: {
    readonly [K in keyof A['claims']]: z.output<A['claims'][K]['schema']>;
  };
};

// Graph

export interface GraphDefinition<
  O extends Record<string, ObjectDefinition> = Record<string, ObjectDefinition>,
  R extends Record<string, RelationshipDefinition> = Record<
    string,
    RelationshipDefinition
  >,
  A extends Record<string, ActionDefinition> = Record<string, ActionDefinition>,
  Access extends AccessVocabulary = AccessVocabulary,
> {
  readonly id: string;
  readonly objects: O;
  readonly relationships: R;
  readonly actions: A;
  readonly access: Access;
  readonly policies: readonly Policy[];
}

/**
 * Keys are the API names consumers call. Relationship endpoints, action
 * targets and created objects must all be registered here.
 */
export declare function defineGraph<
  const O extends Record<string, ObjectDefinition>,
  const R extends Record<
    string,
    RelationshipDefinition<NoInfer<O>[keyof O], NoInfer<O>[keyof O]>
  >,
  const A extends Record<
    string,
    ActionDefinition<
      NoInfer<O>[keyof O],
      z.ZodType,
      z.ZodType,
      readonly Extract<NoInfer<O>[keyof O], NativeObject>[]
    >
  >,
  Access extends AccessVocabulary,
>(graph: {
  id: string;
  objects: O;
  relationships: R;
  actions: A;
  access: Access;
  policies: readonly Policy[];
}): GraphDefinition<O, R, A, Access>;

// Implementations: a synchronous edit builder produces a sealed plan.
// These declarations describe the accepted shape, not an implementation.

type NativeValues<O extends ObjectDefinition> = {
  readonly [
    K in keyof O['properties'] as O['properties'][K] extends NativeOrigin
      ? K
      : never
  ]: z.output<O['properties'][K]['schema']>;
};

/**
 * Detached before-state, fetched as the actor before planning. No ambient
 * reads or read-your-writes. This array is an interim fixture surface: richer
 * selection, freshness and completeness contracts remain open.
 */
type ActionContext<V extends AccessVocabulary, A extends ActionDefinition> = {
  readonly actor: Pick<Principal<V>, 'id' | 'claims'>;
  readonly target: { readonly id: string };
  readonly input: z.output<A['input']>;
  readonly reads: {
    readonly [K in keyof A['reads']]: readonly ObjectRecord<
      A['reads'][K]['to']
    >[];
  };
};

declare const actionPlan: unique symbol;

/**
 * Opaque sealed result, constructed only by this invocation's builder.
 * Its eventual serialized representation contains data, never callbacks or
 * object definitions. The format and runtime provenance checks are still open.
 * The brand is a type boundary, not authorization or a security mechanism.
 */
export interface ActionPlan<A extends ActionDefinition> {
  readonly [actionPlan]: A;
}

export interface Changes<A extends ActionDefinition> {
  /**
   * Records a complete creation without writing. Allocates its native ID now;
   * the object exists only after commit. Only declared native types are valid.
   */
  create<O extends A['creates'][number]>(
    object: O,
    values: NativeValues<NoInfer<O>>,
  ): { readonly id: string };
  /**
   * Seals edits and output into an immutable plan. Later builder use rejects
   * at runtime. The runtime validates output and proposed values before commit.
   */
  build(output: z.input<A['output']>): ActionPlan<A>;
}

export type ImplementationFunction<
  G extends GraphDefinition,
  A extends ActionDefinition,
> = (
  context: ActionContext<G['access'], A> & { readonly changes: Changes<A> },
) => ActionPlan<A>;

/** An action-bound implementation, independent of graph registration names. */
export interface ActionImplementation<
  A extends ActionDefinition,
  V extends AccessVocabulary,
> {
  readonly action: A;
  readonly access: V;
  readonly implementation: (
    context: ActionContext<V, A> & { readonly changes: Changes<A> },
  ) => ActionPlan<A>;
}

/** Server-only binder. The vocabulary supplies types, never permissions. */
export declare function createActionImplementer<V extends AccessVocabulary>(
  access: V,
): <A extends ActionDefinition>(
  action: A,
  implementation: ActionImplementation<NoInfer<A>, V>['implementation'],
) => ActionImplementation<A, V>;

type Named = { readonly action: { readonly id: string } };

type Unique<
  T extends readonly Named[],
  Seen extends string = never,
> = T extends readonly [
  infer H extends Named,
  ...infer R extends readonly Named[],
]
  ? H['action']['id'] extends Seen
    ? false
    : Unique<R, Seen | H['action']['id']>
  : true;

type RegistrationError<Message extends string, Detail = never> = {
  readonly registrationError: Message;
  readonly detail: Detail;
};

type Complete<Ids extends string, T extends readonly Named[]> =
  // A widened array cannot establish exact coverage or uniqueness.
  number extends T['length']
    ? RegistrationError<'Use a literal array or readonly tuple'>
    : string extends Ids | T[number]['action']['id']
      ? RegistrationError<'Preserve literal action IDs'>
      : Unique<T> extends true
        ? Exclude<Ids, T[number]['action']['id']> extends never
          ? unknown
          : RegistrationError<
              'Missing action implementations',
              Exclude<Ids, T[number]['action']['id']>
            >
        : RegistrationError<'Duplicate action implementations'>;

// Connections

export interface Connection {
  readonly sourceId: string;
}

/** Binds a source to its provider. The connector is checked against the schema. */
export declare function connect<S extends Record<string, z.ZodType>>(
  source: { readonly id: string; readonly schema: z.ZodObject<S> },
  binding: {
    connectionId: string;
    connector: {
      fetch(
        sourceRecordId: string,
        options: { signal: AbortSignal },
      ): Promise<
        | { state: 'present'; record: z.input<z.ZodObject<S>> }
        | { state: 'deleted' }
      >;
    };
  },
): Connection;

// Results

type Ok = Extract<ReadResult, { status: 'ok' }>;

type Names<O extends ObjectDefinition> = keyof O['properties'] & string;

export type ReadOptions<K extends string> = Omit<ReadRequest, 'select'> & {
  /** Defaults to every property the caller may read. */
  readonly select?: readonly K[];
};

/**
 * A selected property can still be missing: the caller may lack its field
 * group, or its source may be unavailable. `meta.fields` says which.
 */
export interface ObjectRecord<
  O extends ObjectDefinition,
  K extends Names<O> = Names<O>,
> {
  readonly id: string;
  readonly data: {
    readonly [N in K]?: z.output<O['properties'][N]['schema']>;
  };
  readonly meta: Omit<Ok['meta'], 'fields'> & {
    readonly fields: { readonly [N in K]?: FieldEvidence };
  };
}

export type ObjectResult<
  O extends ObjectDefinition,
  K extends Names<O> = Names<O>,
> =
  | { readonly status: 'not-found' }
  | ({ readonly status: 'ok' } & ObjectRecord<O, K>);

/** A page may be empty without being the last one. Continue until exhausted. */
export interface Page<
  O extends ObjectDefinition,
  K extends Names<O> = Names<O>,
> {
  readonly data: readonly ObjectRecord<O, K>[];
  readonly meta: {
    readonly continuationCursor: string | null;
    readonly exhausted: boolean;
  };
}

export type PageOptions<K extends string> = ReadOptions<K> & {
  readonly limit?: number;
  readonly cursor?: string;
};

export type Receipt<A extends ActionDefinition> =
  | { readonly state: 'succeeded'; readonly output: z.output<A['output']> }
  | { readonly state: 'pending' | 'failed' | 'uncertain' };

// Consumer

type Edge<R extends RelationshipDefinition, O extends ObjectDefinition> =
  | (R['from']['id'] extends O['id']
      ? { traversal: R['forward']; target: R['to'] }
      : never)
  | (R['to']['id'] extends O['id']
      ? { traversal: R['reverse']; target: R['from'] }
      : never);

type Edges<G extends GraphDefinition, O extends ObjectDefinition> = {
  [K in keyof G['relationships']]: Edge<G['relationships'][K], O>;
}[keyof G['relationships']];

type Traversals<G extends GraphDefinition, O extends ObjectDefinition> = {
  readonly [E in Edges<G, O> as E['traversal']['name']]: <
    K extends Names<E['target']> = Names<E['target']>,
  >(
    id: string,
    options?: E['traversal']['cardinality'] extends 'many'
      ? PageOptions<K>
      : ReadOptions<K>,
  ) => Promise<
    E['traversal']['cardinality'] extends 'many'
      ? Page<E['target'], K>
      : ObjectResult<E['target'], K>
  >;
};

export interface ObjectOperations<
  G extends GraphDefinition,
  O extends ObjectDefinition,
> {
  get<K extends Names<O> = Names<O>>(
    id: string,
    options?: ReadOptions<K>,
  ): Promise<ObjectResult<O, K>>;
  list<K extends Names<O> = Names<O>>(
    options?: PageOptions<K>,
  ): Promise<Page<O, K>>;
  /** Both directions of every relationship that touches this object. */
  readonly traverse: Traversals<G, O>;
}

/** Everything one authenticated caller may do. Policy applies to every call. */
export interface Consumer<G extends GraphDefinition> {
  readonly objects: {
    readonly [K in keyof G['objects']]: ObjectOperations<G, G['objects'][K]>;
  };
  readonly actions: {
    readonly [N in keyof G['actions']]: (request: {
      target: string;
      input: z.input<G['actions'][N]['input']>;
      /** Reusing a key with different input fails. */
      idempotencyKey: string;
    }) => Promise<Receipt<G['actions'][N]>>;
  };
}

// Application

type Sourced<G extends GraphDefinition> = Extract<
  G['objects'][keyof G['objects']],
  { readonly membership: SourceMembership }
>;

export interface Relate<G extends GraphDefinition> {
  /** The only way to reach data. The host vouches for the principal. */
  as(principal: Principal<G['access']>): Consumer<G>;
  /**
   * Operations for the host: the trusted process that embeds Relate and
   * authenticated the callers. Never reachable from a consumer handle or over
   * a transport.
   */
  readonly host: {
    /**
     * Tells Relate that a record of a source-owned object exists, so that it
     * becomes a member of the graph. Relate assigns the record its own object
     * ID, keeps the mapping to `sourceRecordId`, and fetches and retains a
     * first observation. The source stays the owner of the data.
     *
     * The word is deliberate. It is not `create`: that is what an action does
     * to a record Relate owns. It is not `insert` or `import`: Relate does not
     * take over the data, it adopts the record as a member and keeps reading
     * the source for it. Reads never adopt; an unknown ID is not found.
     *
     * In the product, synchronization discovers records from the membership
     * source and adopts them automatically. This call remains for tests,
     * backfills and repair. Adopting the same record twice is idempotent and
     * returns the same object ID.
     */
    adopt(object: Sourced<G>, sourceRecordId: string): Promise<string>;
  };
  close(): Promise<void>;
}

/**
 * The one public entry: compiles the graph and wires it. Today's
 * `@relate/runtime` `createRuntime({ model })` becomes the engine beneath it,
 * taking a compiled model; it is not a second authoring entry. Open: which
 * package exports this one, given `@relate/runtime` cannot import the compiler.
 */
export declare function createRuntime<
  G extends GraphDefinition,
  const T extends readonly {
    [K in keyof NoInfer<G>['actions']]: ActionImplementation<
      NoInfer<G>['actions'][K],
      NoInfer<G>['access']
    >;
  }[keyof G['actions']][],
>(options: {
  graph: G;
  /**
   * Exactly one implementation per graph action ID. Inferred from a literal
   * array or readonly tuple. Runtime still validates contracts and access.
   */
  actionImplementations: T &
    Complete<G['actions'][keyof G['actions']]['id'], T>;
  /** One per source the graph uses; a missing one fails at startup. */
  connections: readonly Connection[];
  /** Defaults to an isolated in-memory store. */
  store?: ObservationStore;
  /** The installed instance. Defaults to the graph's `id`. */
  graphId?: string;
  clock?: () => number;
}): Relate<G>;
