import type {
  EvidenceMode,
  FieldEvidence,
  ReadMeta,
  ReadRequest,
} from '@relate/protocol';
import type {
  ObjectData,
  ObjectDefinition,
  ObjectId,
  PropertyNames,
  PropertyValue,
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
export type ReadOptions<
  K extends string,
  E extends EvidenceMode = EvidenceMode,
> = Omit<ReadRequest, 'select' | 'evidence'> & {
  /** Property names to read from the object. */
  readonly select?: readonly K[];
  /** Evidence presentation; defaults to compact. */
  readonly evidence?: E;
};

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
> = ReadOptions<K, E> & {
  readonly limit?: number;
  readonly cursor?: string;
};

/**
 * Filter and page through objects already adopted into the graph.
 *
 * Filters combine with AND and use exact equality. Reference properties take
 * Relate object IDs. Queries do not discover provider-wide records.
 *
 * @example
 * ```ts
 * const customers = await objects.Customer.query({
 *   select: ['name', 'status'],
 *   where: { status: 'active' },
 *   limit: 20,
 * });
 * ```
 */
export type QueryOptions<
  O extends ObjectDefinition,
  K extends PropertyNames<O> = PropertyNames<O>,
  E extends EvidenceMode = EvidenceMode,
> = PageOptions<K, E> & {
  /** Exact-match filters keyed by object property name. */
  readonly where?: {
    readonly [N in PropertyNames<O>]?: Exclude<PropertyValue<O, N>, undefined>;
  };
};

export type ObjectRecord<
  O extends ObjectDefinition,
  K extends PropertyNames<O> = PropertyNames<O>,
  E extends EvidenceMode = EvidenceMode,
> = Omit<Extract<ObjectResult<O, K, E>, { status: 'ok' }>, 'status'>;

export type { QueryResult } from '@relate/protocol';
