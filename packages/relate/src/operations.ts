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

export type ReadOptions<
  K extends string,
  E extends EvidenceMode = EvidenceMode,
> = Omit<ReadRequest, 'select' | 'evidence'> & {
  readonly select?: readonly K[];
  readonly evidence?: E;
};

type TypedMeta<M, K extends string> = M extends { fields: unknown }
  ? Omit<M, 'fields'> & {
      readonly fields: { readonly [N in K]?: FieldEvidence };
    }
  : Omit<M, 'fields'> & {
      readonly fields?: { readonly [N in K]?: FieldEvidence };
    };

/** Read methods infer `E` from the request; omitting `evidence` means compact. */
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

export type QueryOptions<
  O extends ObjectDefinition,
  K extends PropertyNames<O> = PropertyNames<O>,
  E extends EvidenceMode = EvidenceMode,
> = PageOptions<K, E> & {
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
