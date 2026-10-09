import type {
  GraphDefinition,
  ObjectDefinition,
  ObjectId,
  ObjectRegistry,
  PropertyNames,
  RelationshipDefinition,
  RelationshipRegistry,
  ReadOptions,
  ObjectResult,
  Receipt,
  ActionDefinition,
  ActionRequest,
  QueryOptions,
  ObjectRecord,
  PageOptions,
} from 'relate';
import type { EvidenceMode, Page as ResultPage } from '@relate/protocol';
import type { QueryResult } from '@relate/runtime';
import type { Principal } from '@relate/runtime';
import type {
  ActionDescription,
  GraphDescription,
  ObjectDescription as RuntimeObjectDescription,
  TraversalDescription as RuntimeTraversalDescription,
} from '@relate/runtime';

/** A traversal with this SDK's call path, e.g. `objects.Playlist.traverse.songs(id, options?)`. */
export interface TraversalDescription extends RuntimeTraversalDescription {
  readonly call: string;
}

/** Object detail with this SDK's call paths for get, query and each traversal. */
export interface ObjectDescription extends Omit<
  RuntimeObjectDescription,
  'operations' | 'traversals'
> {
  readonly operations: {
    readonly get: RuntimeObjectDescription['operations']['get'] & {
      readonly call: string;
    };
    readonly query: RuntimeObjectDescription['operations']['query'] & {
      readonly call: string;
    };
  };
  readonly traversals: readonly TraversalDescription[];
}

export type { ReadOptions, ObjectResult } from 'relate';

export type { PageOptions, QueryOptions, ObjectRecord } from 'relate';

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

export interface Consumer<
  G extends GraphDefinition & { readonly objects: ObjectRegistry },
> {
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

export interface Relate<
  G extends GraphDefinition & { readonly objects: ObjectRegistry },
> {
  as(principal: Principal): Consumer<G>;
  readonly host: {
    adopt<
      O extends Extract<
        G['objects'][keyof G['objects']],
        { membership: { resource: unknown } }
      >,
    >(
      object: O,
      sourceRecordId: string,
    ): Promise<ObjectId<O['id']>>;
  };
  /** Stop new operations and await in-flight operations. Borrowed stores remain open. */
  close(): Promise<void>;
}
