import type { LocalDateTimeSchema } from './local-datetime.js';
import type { z } from 'zod';
import type {
  EvidenceMode,
  FieldEvidence,
  ReadMeta,
  ReadControls,
  ObjectReadRequest,
  AnalyticalExpression,
  ComputedResultType,
  FilterScalar,
  FilterOperators,
} from '@relate/protocol';
import type {
  ObjectData,
  ObjectDefinition,
  ObjectId,
  PropertyNames,
  Property,
  PropertyValue,
  ComputedPropertyNames,
} from './index.js';

/**
 * Select properties and control evidence detail for an object read.
 *
 * Evidence is compact by default. Request `full` when you need provenance for
 * every selected field. Selection never bypasses authorization.
 *
 * @example
 * ```ts
 * const customer = await objects.Customer.get(customerId, {
 *   select: ['name'],
 *   evidence: 'full',
 * });
 * ```
 */
export type ReadControlOptions<
  K extends string,
  E extends EvidenceMode = EvidenceMode,
> = Omit<ReadControls, 'select' | 'evidence'> & {
  /** Property names to read from the object. */
  readonly select?: readonly K[];
  /** Evidence presentation; defaults to compact. */
  readonly evidence?: E;
};

/** Object reads may extend common controls without widening traversal. */
export type ReadOptions<
  K extends string,
  E extends EvidenceMode = EvidenceMode,
> = ReadControlOptions<K, E> & Omit<ObjectReadRequest, keyof ReadControls>;

type TypedMeta<M, K extends string> = M extends { fields: unknown }
  ? Omit<M, 'fields'> & {
      readonly fields: { readonly [N in K]?: FieldEvidence };
    }
  : Omit<M, 'fields'> & {
      readonly fields?: { readonly [N in K]?: FieldEvidence };
    };

/** Read methods guarantee full only for a required full evidence option. */
export type ObjectResult<
  O extends ObjectDefinition,
  K extends PropertyNames<O> = PropertyNames<O>,
  E extends EvidenceMode = EvidenceMode,
> =
  | { readonly status: 'not-found' }
  | {
      readonly status: 'ok';
      readonly id: ObjectId<O['id']>;
      readonly data: ObjectData<O, K>;
      readonly meta: TypedMeta<Extract<ReadMeta, { evidence: E }>, K>;
    };

export type PageOptions<
  K extends string,
  E extends EvidenceMode = EvidenceMode,
> = ReadControlOptions<K, E> & {
  readonly limit?: number;
  readonly cursor?: string;
};

type UnwrapSchema<S> = S extends
  z.ZodOptional<infer Inner> | z.ZodNullable<infer Inner>
  ? UnwrapSchema<Inner>
  : S;

type EqualityOperators<V> = {
  readonly eq?: V;
  readonly in?: readonly V[];
};

type RangeOperators<V> = {
  readonly gt?: NonNullable<V>;
  readonly gte?: NonNullable<V>;
  readonly lt?: NonNullable<V>;
  readonly lte?: NonNullable<V>;
};

type PropertyFilter<P extends Property, V> =
  | V
  | (EqualityOperators<V> &
      (P['origin']['kind'] extends 'computed'
        ? RangeOperators<V>
        : UnwrapSchema<P['schema']> extends
              | z.ZodNumber
              | z.ZodBigInt
              | z.iso.ZodISODateTime
              | LocalDateTimeSchema
          ? RangeOperators<V>
          : unknown));

/**
 * Filter and page through objects already adopted into the graph, or through
 * the records a to-many traversal reaches.
 *
 * Properties and operators combine with AND. Use scalar equality, eq/in, or
 * gt/gte/lt/lte on numbers, timestamps and declared local datetimes. Reference properties take
 * Relate object IDs. Queries do not discover provider-wide records. A
 * traversal's filters address the related object's properties and apply in
 * addition to the relationship.
 *
 * @example
 * ```ts
 * const customers = await objects.Customer.query({
 *   select: ['name', 'status'],
 *   where: { status: 'active' },
 *   limit: 20,
 * });
 * const open = await objects.Customer.traverse.invoices(customerId, {
 *   where: { status: 'open', totalMinor: { gte: 10_000 } },
 * });
 * ```
 */
export type CollectionReadOptions<
  O extends ObjectDefinition,
  K extends PropertyNames<O> = PropertyNames<O>,
  E extends EvidenceMode = EvidenceMode,
> = PageOptions<K, E> & {
  /** Typed scalar predicates keyed by object property name. */
  readonly where?: {
    readonly [N in PropertyNames<O>]?: PropertyFilter<
      O['properties'][N],
      Exclude<PropertyValue<O, N>, undefined>
    >;
  };
};

/** Object queries have an independent extension point from related collections. */
export type QueryOptions<
  O extends ObjectDefinition,
  K extends PropertyNames<O> = PropertyNames<O>,
  E extends EvidenceMode = EvidenceMode,
> = CollectionReadOptions<O, K, E> &
  ReadOptions<K, E> & {
    readonly orderBy?: readonly {
      readonly field: ComputedPropertyNames<O>;
      readonly direction: 'asc' | 'desc';
    }[];
  };

/** SQL result types are inferred at runtime; aliases cannot be inferred from misspelled filters. */
export type ComputedQueryOptions<
  O extends ObjectDefinition,
  K extends PropertyNames<O>,
  E extends EvidenceMode,
  C extends Expressions,
> = Omit<QueryOptions<O, K, E>, 'where' | 'orderBy' | 'compute'> &
  ComputeOptions<O, C> & {
    readonly where?: CollectionReadOptions<O, K, E>['where'] & {
      readonly [A in keyof NoInfer<C>]?: FilterScalar | FilterOperators;
    };
    readonly orderBy?: readonly {
      readonly field: Extract<
        keyof NoInfer<C> | ComputedPropertyNames<O>,
        string
      >;
      readonly direction: 'asc' | 'desc';
    }[];
  };

export type ObjectRecord<
  O extends ObjectDefinition,
  K extends PropertyNames<O> = PropertyNames<O>,
  E extends EvidenceMode = EvidenceMode,
> = Omit<Extract<ObjectResult<O, K, E>, { status: 'ok' }>, 'status'>;

export type { QueryResult } from '@relate/protocol';

export type Expressions = Readonly<Record<string, AnalyticalExpression>>;

export type ComputeOptions<
  O extends ObjectDefinition,
  C extends Expressions,
> = {
  readonly compute?: C &
    Record<
      Extract<
        keyof C,
        PropertyNames<O> | '__proto__' | 'constructor' | 'prototype'
      >,
      never
    >;
};

export type WithComputed<R, C extends Expressions> = keyof C extends never
  ? R
  : R extends { readonly data: infer D; readonly meta: infer M }
    ? Omit<R, 'data' | 'meta'> & {
        readonly data: D & {
          readonly [A in keyof C]?: string | number | boolean | null;
        };
        readonly meta: M & {
          readonly computed: { readonly [A in keyof C]: ComputedResultType };
          readonly fields?: { readonly [A in keyof C]?: FieldEvidence };
        };
      }
    : R;
