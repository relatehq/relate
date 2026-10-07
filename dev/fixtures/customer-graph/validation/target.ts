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
  FieldGroup,
  FieldReference,
  Property,
  PropertyValue,
  ObjectId,
  RoleGate,
  defineAccess as currentDefineAccess,
  source,
} from 'relate';
import type {
  FieldEvidence,
  Page as ResultPage,
  ReadRequest,
  ReadResult,
} from '@relate/protocol';
import type { QueryResult } from '@relate/runtime';
import type { ObservationStore } from '@relate/runtime/storage';

export {
  defineSource,
  from,
  objectId,
  source,
  referenceInput,
  native,
  nativeMembership,
} from 'relate';

// Definitions

type Options<Id extends string> = { id: Id; access: FieldGroup };

type NativeOrigin = { readonly origin: { readonly kind: 'native' } };

export interface ReferenceProperty<
  Target extends string = string,
> extends Property<z.ZodString> {
  /** The referenced object definition's `id`. Values are its object IDs. */
  readonly references: Target;
  readonly target: ObjectDefinition;
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
): ReferenceProperty<T['id']> & { readonly id: Id; readonly target: T };

export declare function reference<
  T extends ObjectDefinition,
  const Id extends string,
>(
  target: T,
  options: Options<Id>,
): ReferenceProperty<T['id']> &
  NativeOrigin & { readonly id: Id; readonly target: T };

export interface NativeMembership {
  readonly kind: 'native';
}

export type SourceMembership = ReturnType<typeof source>;

export interface ObjectDefinition<
  Id extends string = string,
  P extends Record<string, Property> = Record<string, Property>,
  M extends SourceMembership | NativeMembership =
    SourceMembership | NativeMembership,
> {
  readonly id: Id;
  readonly label?: string;
  readonly pluralLabel?: string;
  readonly description?: string;
  readonly membership: M;
  readonly properties: P;
}

export declare function defineObject<
  const Id extends string,
  const P extends Record<string, Property>,
  M extends SourceMembership | NativeMembership,
>(definition: {
  id: Id;
  label?: string;
  pluralLabel?: string;
  description?: string;
  membership: M;
  properties: P;
}): DefinedObject<Id, P, M>;

type DefinedObject<
  Id extends string,
  P extends Record<string, Property>,
  M extends SourceMembership | NativeMembership,
> = ObjectDefinition<
  Id,
  {
    readonly [K in keyof P]: Omit<P[K], 'owner'> & {
      readonly owner: DefinedObject<Id, P, M>;
    };
  },
  M
>;

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
  readonly via: ReferenceProperty<From['id']> & {
    readonly target: From;
    readonly owner: To;
  };
}

/** Declared outside both objects; derives endpoints from a bound reference. */
export declare function defineRelationship<
  Via extends ReferenceProperty & { readonly owner: ObjectDefinition },
  const Forward extends string,
  const Reverse extends string,
>(definition: {
  id: string;
  forward: Forward;
  reverse: Reverse;
  via: Via;
}): RelationshipDefinition<
  Via['target'],
  Via['owner'],
  { readonly name: Forward; readonly cardinality: 'many' },
  { readonly name: Reverse; readonly cardinality: 'one' }
>;

type NativeObject = ObjectDefinition<
  string,
  Record<string, Property>,
  NativeMembership
>;

export type ActionErrors = Record<string, z.ZodType>;

export interface ActionDefinition<
  Input extends z.ZodType = z.ZodType,
  Output extends z.ZodType = z.ZodType,
  Creates extends readonly NativeObject[] = readonly NativeObject[],
  Errors extends ActionErrors = ActionErrors,
> {
  readonly id: string;
  readonly input: Input;
  readonly output: Output;
  readonly creates: Creates;
  readonly errors: Errors;
  readonly policy?: ActionPolicy;
}

export declare function defineAction<
  const Id extends string,
  Input extends z.ZodType,
  Output extends z.ZodType,
  const Creates extends readonly NativeObject[],
  const Errors extends ActionErrors = {},
>(definition: {
  id: Id;
  input: Input;
  output: Output;
  creates: Creates;
  /** Expected business failures only; omission declares none. */
  errors?: Errors;
  /** Omission denies discovery and execution. */
  policy?: ActionPolicy;
}): ActionDefinition<Input, Output, Creates, Errors> & { readonly id: Id };

// Access

export interface ActionPolicy {
  readonly execute: RoleGate;
}

type CurrentAccess<
  R extends readonly string[],
  G extends readonly string[],
  C extends Record<string, z.ZodType>,
> = ReturnType<typeof currentDefineAccess<R, G, C>>;

/** Trusted actor operand. Actor identity is separate from user-supplied input. */
export interface ActorField<S extends z.ZodType = z.ZodType> {
  readonly kind: 'actor-field';
  readonly name: 'id';
  readonly schema: S;
}

/** Nested to-one equality predicates. References resolve through the registry. */
export type PolicyWhere<
  Registry extends ObjectRegistry,
  O extends ObjectDefinition,
> = {
  readonly [
    K in keyof O['properties']
  ]?: O['properties'][K] extends ReferenceProperty<infer Id>
    ? PolicyWhere<Registry, Extract<Registry[keyof Registry], { id: Id }>>
    : {
        readonly eq:
          | Claim<z.ZodType<z.output<O['properties'][K]['schema']>>>
          | ActorField<z.ZodType<z.output<O['properties'][K]['schema']>>>;
      };
};

// Also reject surplus keys on extracted conditions, not only fresh literals.
type ExactPolicyInput<Input, Shape> = Shape extends Claim | ActorField
  ? Input
  : Input extends (...args: never[]) => unknown
    ? Input
    : Input extends object
      ? Shape extends object
        ? {
            [K in keyof Input]: K extends keyof Shape
              ? ExactPolicyInput<Input[K], NonNullable<Shape[K]>>
              : never;
          }
        : never
      : Input;

declare const integrityRoot: unique symbol;
declare const referenceTarget: unique symbol;

export interface ReferencePath<Root extends string, Target extends string> {
  readonly path: readonly string[];
  readonly [integrityRoot]: Root;
  readonly [referenceTarget]: Target;
}

export type IntegrityFields<
  Registry extends ObjectRegistry,
  O extends ObjectDefinition,
  Root extends string = O['id'],
> = {
  readonly [
    K in keyof O['properties'] as O['properties'][K] extends ReferenceProperty
      ? K
      : never
  ]: O['properties'][K] extends ReferenceProperty<infer Target>
    ? ReferencePath<Root, Target> &
        IntegrityFields<
          Registry,
          Extract<Registry[keyof Registry], { id: Target }>,
          Root
        >
    : never;
};

export interface SameRecord<Root extends string> {
  readonly kind: 'same-record';
  readonly left: readonly string[];
  readonly right: readonly string[];
  readonly [integrityRoot]: Root;
}

export interface IntegrityContext<
  Registry extends ObjectRegistry,
  O extends ObjectDefinition,
> {
  readonly fields: IntegrityFields<Registry, O>;
  same<Target extends string>(
    left: ReferencePath<O['id'], Target>,
    right: ReferencePath<O['id'], NoInfer<Target>>,
  ): SameRecord<O['id']>;
}

export type IntegrityRule<
  Registry extends ObjectRegistry,
  O extends ObjectDefinition,
> = (context: IntegrityContext<Registry, O>) => readonly SameRecord<O['id']>[];

export type ObjectRule<Role extends string, W> =
  | { gate: RoleGate<Role>; where?: never; evidenceMaxAgeMs?: never }
  | { gate: RoleGate<Role>; where: W; evidenceMaxAgeMs: number };

/** Object policies accept native objects; actions retain colocated policies. */
export declare function defineAccess<
  const R extends readonly string[],
  const G extends readonly string[],
  C extends Record<string, z.ZodType>,
>(definition: {
  roles: R;
  fieldGroups: G;
  claims: C;
}): CurrentAccess<R, G, C> & {
  readonly actor: { readonly id: ActorField<z.ZodString> };
};

export type Policies<
  Registry extends ObjectRegistry,
  Access extends AccessVocabulary,
> = {
  readonly [K in keyof Registry]: {
    readonly read:
      | 'deny'
      | ObjectRule<Access['roles'][number], PolicyWhere<Registry, Registry[K]>>;
    /** Absence denies native creation; read access is not write authority. */
    readonly create?: Registry[K] extends { membership: NativeMembership }
      ? | 'deny'
        | ObjectRule<
            Access['roles'][number],
            PolicyWhere<Registry, Registry[K]>
          >
      : never;
    readonly integrity?: Registry[K] extends { membership: NativeMembership }
      ? IntegrityRule<Registry, Registry[K]>
      : never;
    readonly groups?: Partial<
      Record<
        Exclude<Access['fieldGroups'][number], 'ordinary'>,
        RoleGate<Access['roles'][number]>
      >
    > & { readonly ordinary?: never };
  };
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
  readonly policies: Readonly<Record<string, unknown>>;
}

/**
 * Keys are the API names consumers call. Relationship endpoints, action
 * created objects must all be registered here. Input references need runtime validation.
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
      z.ZodType,
      z.ZodType,
      readonly Extract<NoInfer<O>[keyof O], NativeObject>[]
    >
  >,
  Access extends AccessVocabulary,
  const P extends Policies<NoInfer<O>, NoInfer<Access>>,
>(graph: {
  id: string;
  objects: O;
  relationships: R;
  actions: A;
  access: Access;
  policies: P & ExactPolicyInput<P, Policies<NoInfer<O>, NoInfer<Access>>>;
}): GraphDefinition<O, R, A, Access> & { readonly policies: P };

// Async implementation context: declarations only, no executor.
type NativeValues<O extends ObjectDefinition> = {
  readonly [
    K in keyof O['properties'] as O['properties'][K] extends NativeOrigin
      ? K
      : never
  ]: O['properties'][K] extends ReferenceProperty
    ? PropertyValue<O, K>
    : z.input<O['properties'][K]['schema']>;
};

type ObjectRegistry = Record<string, ObjectDefinition>;

type RelationshipRegistry = Record<string, RelationshipDefinition>;

type QueryOptions<
  O extends ObjectDefinition,
  K extends Names<O>,
> = PageOptions<K> & {
  /** Equality-only fixture sketch; query execution must not silently omit unknown matches. */
  readonly where?: Partial<{
    readonly [N in Names<O>]: PropertyValue<O, N>;
  }>;
};

export type ActionObjects<
  O extends ObjectRegistry,
  R extends RelationshipRegistry,
  A extends ActionDefinition,
> = {
  readonly [N in keyof O]: ObjectOperations<R, O[N]> &
    (O[N] extends A['creates'][number]
      ? {
          /** Writes inside the runtime-owned native transaction; not an independent commit. */
          create(
            values: NativeValues<O[N]>,
          ): Promise<{ readonly id: ObjectId<O[N]['id']> }>;
        }
      : {});
};

type ActionContext<
  V extends AccessVocabulary,
  A extends ActionDefinition,
  O extends ObjectRegistry,
  R extends RelationshipRegistry,
> = {
  readonly actor: Pick<Principal<V>, 'id' | 'claims'>;
  readonly input: z.output<A['input']>;
  readonly objects: ActionObjects<O, R, A>;
  /** Aborts the invocation; native writes must roll back even if caught. */
  readonly fail: (
    ...args: {
      [Code in keyof A['errors'] & string]: [
        code: Code,
        details: z.input<A['errors'][Code]>,
      ];
    }[keyof A['errors'] & string]
  ) => never;
};

export interface ActionImplementation<
  A extends ActionDefinition,
  V extends AccessVocabulary,
  O extends ObjectRegistry,
  R extends RelationshipRegistry,
> {
  readonly action: A;
  readonly access: V;
  readonly objects: O;
  readonly relationships: R;
  readonly implementation: (
    context: ActionContext<V, A, O, R>,
  ) => Promise<z.input<A['output']>>;
}

/** Graph vocabulary, objects and relationships provide inference, never grants. */
export declare function implementAction<
  G extends GraphDefinition,
  A extends ActionDefinition,
>(
  graph: G,
  action: A,
  implementation: ActionImplementation<
    NoInfer<A>,
    NoInfer<G>['access'],
    NoInfer<G>['objects'],
    NoInfer<G>['relationships']
  >['implementation'],
): ActionImplementation<A, G['access'], G['objects'], G['relationships']>;

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
  readonly id: ObjectId<O['id']>;
  readonly data: {
    readonly [N in K]?: PropertyValue<O, N>;
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
export type Page<
  O extends ObjectDefinition,
  K extends Names<O> = Names<O>,
> = ResultPage<ObjectRecord<O, K>>;

export type PageOptions<K extends string> = ReadOptions<K> & {
  readonly limit?: number;
  readonly cursor?: string;
};

/** Schema output after runtime validation, never an arbitrary thrown message. */
export type DomainActionError<A extends ActionDefinition> = {
  [Code in keyof A['errors'] & string]: {
    readonly kind: 'domain';
    readonly code: Code;
    readonly details: z.output<A['errors'][Code]>;
  };
}[keyof A['errors'] & string];

/** Runtime-owned failures require no per-action declaration. */
export interface RuntimeActionError {
  readonly kind: 'runtime';
  readonly code:
    | 'denied'
    | 'not-found'
    | 'invalid'
    | 'conflict'
    | 'unsupported'
    | 'unavailable'
    | 'internal';
}

/** A snapshot of one accepted invocation; lookup/replay retains its identity. */
export type Receipt<A extends ActionDefinition> = {
  /** Opaque runtime-assigned ID, never an authorization credential. */
  readonly invocationId: string;
} & (
  | { readonly state: 'succeeded'; readonly output: z.output<A['output']> }
  | {
      readonly state: 'failed';
      readonly error: DomainActionError<A> | RuntimeActionError;
    }
  /** Durably accepted, with no final outcome yet. */
  | { readonly state: 'pending' }
  /** Relate cannot establish the effect outcome; do not blindly resubmit. */
  | { readonly state: 'uncertain' }
);

// Shared reads

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
  readonly [E in Edges<R, O> as E['traversal']['name']]: <
    K extends Names<E['target']> = Names<E['target']>,
  >(
    id: ObjectId<O['id']>,
    options?: E['traversal']['cardinality'] extends 'many'
      ? PageOptions<K>
      : ReadOptions<K>,
  ) => E['traversal']['cardinality'] extends 'many'
    ? QueryResult<ObjectRecord<E['target'], K>>
    : Promise<ObjectResult<E['target'], K>>;
};

/** Same read contract for consumers and actions; every call applies policy. */
export interface ObjectOperations<
  R extends RelationshipRegistry,
  O extends ObjectDefinition,
> {
  get<K extends Names<O> = Names<O>>(
    id: ObjectId<O['id']>,
    options?: ReadOptions<K>,
  ): Promise<ObjectResult<O, K>>;
  /** Omit `where` (or all options) to enumerate without a filter. */
  query<K extends Names<O> = Names<O>>(
    options?: QueryOptions<O, K>,
  ): QueryResult<ObjectRecord<O, K>>;
  /** Both directions of every relationship that touches this object. */
  readonly traverse: Traversals<R, O>;
}

// Consumer

/** Everything one authenticated caller may do. Policy applies to every call. */
export interface Consumer<G extends GraphDefinition> {
  readonly objects: {
    readonly [K in keyof G['objects']]: ObjectOperations<
      G['relationships'],
      G['objects'][K]
    >;
  };
  readonly actions: {
    readonly [N in keyof G['actions']]: (request: {
      input: z.input<G['actions'][N]['input']>;
      /** Reusing a key with different input fails. */
      idempotencyKey: string;
    }) => Promise<Exclude<Receipt<G['actions'][N]>, { state: 'pending' }>>;
  };
  readonly receipts: {
    /**
     * Read an existing invocation's latest receipt without executing the action.
     * Check graph/action identity and current receipt authorization at runtime.
     * Missing, mismatched or inaccessible receipts reject without disclosing
     * stored output/errors; lookup rejection never changes the saved outcome.
     */
    get<A extends G['actions'][keyof G['actions']]>(
      action: A,
      invocationId: string,
    ): Promise<Receipt<A>>;
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
    adopt<O extends Sourced<G>>(
      object: O,
      sourceRecordId: string,
    ): Promise<ObjectId<O['id']>>;
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
      NoInfer<G>['access'],
      NoInfer<G>['objects'],
      NoInfer<G>['relationships']
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
