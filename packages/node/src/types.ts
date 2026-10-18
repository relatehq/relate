import type { GraphDefinition, ObjectId, ObjectRegistry } from 'relate';
import type { Consumer } from 'relate/consumer';
import type {
  ActivityObjectRef,
  ActivityReader,
  ConsumerOperations,
  ObjectProvenance,
  OperationActor,
  OperationContext,
} from '@relate/protocol';
import type { ActivityCounters, Principal } from '@relate/runtime';
import type { DispatchMethod, HostDispatch } from './runtime.js';

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
  operations(
    principal: Principal,
    /**
     * Trusted request context a transport binds per request. Embedded callers
     * omit it and get a fresh request ID per call. Never an operation ID.
     */
    context?: Partial<OperationContext>,
  ): ConsumerOperations;
  /** Trusted host operations; none of these are exposed to consumers. */
  readonly host: {
    /** Attributed to `adoption.actor`, or the system actor `relate.host`. */
    adopt<
      O extends Extract<
        G['objects'][keyof G['objects']],
        { membership: { resource: unknown } }
      >,
    >(
      object: O,
      sourceRecordId: string,
      adoption?: {
        readonly actor?: OperationActor;
        readonly context?: Partial<OperationContext>;
      },
    ): Promise<ObjectId<O['id']>>;
    /** The durable feed and best-effort operation history of this graph. */
    readonly activity: ActivityReader;
    /** Who created or adopted an object. Undefined when the object is unknown. */
    provenance(
      object: ActivityObjectRef,
    ): Promise<ObjectProvenance | undefined>;
    /** Operation-capture drop and truncation counters. */
    activityCounters(): ActivityCounters;
    /**
     * Wait, within `activity.flushTimeoutMs`, until operations captured so far
     * are appended or dropped, so `activity.operations` can read them. Does
     * not stop new operations; `pending` means rows were still queued.
     */
    flushActivity(): Promise<'flushed' | 'pending'>;
    /**
     * Run one consumer operation as `principal` under an operation ID the
     * trusted transport assigned, so it can join its own records to the
     * runtime's. Arguments are the `ConsumerOperations` method's arguments.
     */
    dispatch(
      principal: Principal,
      attempt: HostDispatch,
      method: DispatchMethod,
      args: readonly unknown[],
    ): Promise<unknown>;
  };
  /**
   * Stop new operations, await in-flight operations, then flush captured
   * operations within `activity.flushTimeoutMs`. Borrowed stores remain open.
   */
  close(): Promise<void>;
}
