import type { FieldEvidence, ReadRequest, ReadResult } from '@relate/protocol';
import type {
  ObjectData,
  ObjectDefinition,
  ObjectId,
  PropertyNames,
  PropertyValue,
} from './index.js';

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

export type QueryOptions<
  O extends ObjectDefinition,
  K extends PropertyNames<O> = PropertyNames<O>,
> = PageOptions<K> & {
  readonly where?: {
    readonly [N in PropertyNames<O>]?: Exclude<PropertyValue<O, N>, undefined>;
  };
};

export type ObjectRecord<
  O extends ObjectDefinition,
  K extends PropertyNames<O> = PropertyNames<O>,
> = Omit<Extract<ObjectResult<O, K>, { status: 'ok' }>, 'status'>;

export type { QueryResult } from '@relate/protocol';
