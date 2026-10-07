import type { FieldEvidence, ReadRequest, ReadResult } from '@relate/protocol';
import type {
  ObjectData,
  ObjectDefinition,
  ObjectId,
  PropertyNames,
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
