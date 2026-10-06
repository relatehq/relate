import type {
  GraphDefinition,
  ObjectData,
  ObjectDefinition,
  ObjectId,
  ObjectRegistry,
  PropertyNames,
  RelationshipDefinition,
  RelationshipRegistry,
} from 'relate';
import type {
  FieldEvidence,
  ReadRequest,
  ReadResult,
  Page as ResultPage,
} from '@relate/protocol';
import type { QueryResult } from '@relate/runtime';
import type { Principal } from '@relate/runtime';

export type ReadOptions<K extends string> = Omit<ReadRequest, 'select'> & {
  readonly select?: readonly K[];
};

type Ok = Extract<ReadResult, { status: 'ok' }>;

export type ObjectResult<
  O extends ObjectDefinition,
  K extends PropertyNames<O> = PropertyNames<O>,
> =
  | { readonly status: 'not-found' }
  | {
      readonly status: 'ok';
      readonly id: ObjectId<O['id']>;
      readonly data: ObjectData<O, K>;
      readonly meta: Omit<Ok['meta'], 'fields'> & {
        readonly fields: { readonly [N in K]?: FieldEvidence };
      };
    };

export type PageOptions<K extends string> = ReadOptions<K> & {
  readonly limit?: number;
  readonly cursor?: string;
};

export type ObjectRecord<
  O extends ObjectDefinition,
  K extends PropertyNames<O> = PropertyNames<O>,
> = Omit<Extract<ObjectResult<O, K>, { status: 'ok' }>, 'status'>;

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
  readonly [E in Edges<R, O> as E['traversal']['name']]: <
    K extends PropertyNames<E['target']> = PropertyNames<E['target']>,
  >(
    id: ObjectId<O['id']>,
    options?: E['traversal']['cardinality'] extends 'many'
      ? PageOptions<K>
      : ReadOptions<K>,
  ) => E['traversal']['cardinality'] extends 'many'
    ? QueryResult<ObjectRecord<E['target'], K>>
    : Promise<ObjectResult<E['target'], K>>;
};

export interface ObjectOperations<
  O extends ObjectDefinition,
  R extends RelationshipRegistry = {},
> {
  readonly traverse: Traversals<R, O>;
  get<K extends PropertyNames<O> = PropertyNames<O>>(
    id: ObjectId<O['id']>,
    options?: ReadOptions<K>,
  ): Promise<ObjectResult<O, K>>;
}

export interface Consumer<
  G extends GraphDefinition & { readonly objects: ObjectRegistry },
> {
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
    adopt<O extends G['objects'][keyof G['objects']]>(
      object: O,
      sourceRecordId: string,
    ): Promise<ObjectId<O['id']>>;
  };
  /** Stop new operations and await in-flight operations. Borrowed stores remain open. */
  close(): Promise<void>;
}
