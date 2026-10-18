/** Type-design probe over the existing public facade. Not implemented methods. */
import type { ObjectDefinition, PropertyNames } from 'relate';
import type {
  ObjectResult,
  QueryOptions,
  ReadOptions,
  QueryResult,
} from 'relate/consumer';
import type { Expression, LogicalType, Scalar } from './contracts.js';

type Expressions = Readonly<Record<string, Expression>>;

type Augment<R, C extends Expressions> = R extends {
  data: infer D;
  meta: infer M;
}
  ? Omit<R, 'data' | 'meta'> & {
      // A denied/unavailable alias is absent. SQL text is not a TS type system.
      readonly data: D & { readonly [A in keyof C]?: Scalar };
      readonly meta: M & {
        readonly computed: {
          readonly [A in keyof C]: { type: LogicalType; nullable: boolean };
        };
      };
    }
  : R;

type Compute<O extends ObjectDefinition, C extends Expressions> = {
  readonly compute?: C &
    Record<
      Extract<
        keyof C,
        PropertyNames<O> | '__proto__' | 'constructor' | 'prototype'
      >,
      never
    >;
};

export interface AnalyticalObjectApi<O extends ObjectDefinition> {
  get<
    K extends PropertyNames<O> = PropertyNames<O>,
    const C extends Expressions = {},
  >(
    id: string,
    options: ReadOptions<K> & Compute<O, C>,
  ): Promise<Augment<ObjectResult<O, K>, C>>;
  query<
    K extends PropertyNames<O> = PropertyNames<O>,
    const C extends Expressions = {},
  >(
    options: Omit<QueryOptions<O, K>, 'where'> &
      Compute<O, C> & {
        readonly where?: QueryOptions<O, K>['where'] & {
          readonly [A in keyof NoInfer<C>]?: { eq?: Scalar; gt?: Scalar };
        };
        readonly orderBy?: readonly {
          field: Extract<keyof NoInfer<C>, string>;
          direction: 'asc' | 'desc';
        }[];
      },
  ): QueryResult<
    Omit<Extract<Augment<ObjectResult<O, K>, C>, { status: 'ok' }>, 'status'>
  >;
}
