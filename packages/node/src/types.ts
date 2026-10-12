import type { GraphDefinition, ObjectId, ObjectRegistry } from 'relate';
import type { Consumer } from 'relate/consumer';
import type { ConsumerOperations } from '@relate/protocol';
import type { Principal } from '@relate/runtime';

export type {
  ActionOperations,
  Consumer,
  ObjectDescription,
  ObjectOperations,
  ObjectRecord,
  ObjectResult,
  Page,
  PageOptions,
  QueryOptions,
  QueryResult,
  ReadOptions,
  TraversalDescription,
} from 'relate/consumer';

export interface Relate<
  G extends GraphDefinition & { readonly objects: ObjectRegistry },
> {
  /** The typed consumer facade of `operations(principal)`. */
  as(principal: Principal): Consumer<G>;
  /**
   * The engine's consumer operations bound to one host-authenticated principal
   * and addressed by definition IDs: the surface transport adapters such as
   * `@relate/http` serve. Calls after `close()` reject.
   */
  operations(principal: Principal): ConsumerOperations;
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
