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
} from 'relate';
import type { Page as ResultPage } from '@relate/protocol';
import type { QueryResult } from '@relate/runtime';
import type { Principal } from '@relate/runtime';

export type { ReadOptions, ObjectResult } from 'relate';

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
  readonly actions: G extends {
    readonly actions: infer A extends Readonly<
      Record<string, ActionDefinition>
    >;
  }
    ? {
        readonly [K in keyof A]: (
          request: ActionRequest<A[K]>,
        ) => Promise<Receipt<A[K]>>;
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
