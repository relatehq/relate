import type { ActionError, ReadError } from './index.js';

type ReadErrorCode = ReadError['code'];

type ActionErrorCode = ActionError['code'];

export type ActivityActor =
  | { readonly kind: 'principal'; readonly id: string }
  | { readonly kind: 'system'; readonly id: string }
  /** A source system observed to have changed; id is the source definition ID. */
  | { readonly kind: 'source'; readonly id: string };

export interface OperationContext {
  readonly requestId: string;
  readonly transport: 'embedded' | 'http' | 'mcp';
  readonly executionId?: string;
  readonly runtimeId?: string;
  /** Supplied only by trusted host attribution, never an authorization grant. */
  readonly initiator?: ActivityActor;
}

export interface ActivityObjectRef {
  readonly objectDefinitionId: string;
  readonly objectId: string;
}

export interface OperationObject extends ActivityObjectRef {
  readonly role: 'target' | 'returned' | 'traversal-origin';
  readonly returned: readonly string[]; // Stable property definition IDs.
  readonly forbidden: readonly string[];
  readonly unavailable: readonly string[];
}

export type OperationOutcome =
  | { readonly status: 'ok' | 'not-found' }
  | { readonly status: 'succeeded' }
  | { readonly status: 'failed'; readonly code: string } // domain failure
  | {
      readonly status: 'rejected';
      readonly code: ReadErrorCode | Exclude<ActionErrorCode, 'uncertain'>;
    }
  | { readonly status: 'uncertain' };

type RejectedOutcome = Extract<OperationOutcome, { status: 'rejected' }>;

type UncertainOutcome = Extract<OperationOutcome, { status: 'uncertain' }>;

type InvocationOutcome = Extract<
  OperationOutcome,
  { status: 'succeeded' | 'failed' }
>;

type ReadOutcome = { readonly status: 'ok' | 'not-found' } | RejectedOutcome;

interface OperationEnvelope {
  readonly schemaVersion: 1;
  readonly id: string; // Fresh per attempt; not ActionContext.idempotencyId.
  readonly parentOperationId?: string;
  readonly graphId: string;
  readonly definitionRevision: string;
  readonly actor: ActivityActor;
  readonly context: OperationContext;
  readonly startedAt: string; // RFC 3339
  readonly completedAt: string;
  readonly durationMs: number;
  readonly recordedAt: string;
  readonly objects: readonly OperationObject[]; // In result order.
}

interface OperationDetails {
  /** Present when `objects` exceeded the configured limit and was cut. */
  readonly truncated?: { readonly omittedObjects: number };
}

type InvocationAttempt =
  | {
      readonly outcome: InvocationOutcome;
      readonly invocationId: string;
      readonly replayed: boolean;
    }
  | {
      readonly outcome: RejectedOutcome | UncertainOutcome;
      readonly invocationId?: never;
      readonly replayed: false;
    };

export type Operation = OperationEnvelope &
  (
    | {
        readonly kind: 'get';
        readonly definitionId: string;
        readonly target: ActivityObjectRef;
        readonly outcome: ReadOutcome;
        readonly details: OperationDetails;
      }
    | {
        readonly kind: 'query';
        readonly definitionId: string; // Result object definition, even for an empty page.
        readonly outcome: { readonly status: 'ok' } | RejectedOutcome;
        readonly details: OperationDetails & { readonly hasMore?: boolean };
      }
    | {
        readonly kind: 'traverse';
        readonly definitionId: string; // Result object definition.
        readonly outcome: ReadOutcome;
        readonly details: OperationDetails & {
          readonly traversalId: string;
          readonly from: ActivityObjectRef;
          readonly hasMore?: boolean;
        };
      }
    | ({
        readonly kind: 'invoke';
        readonly definitionId: string; // Action definition.
        readonly details: OperationDetails;
      } & InvocationAttempt)
    | ({
        readonly kind: 'receipt';
        readonly definitionId: string; // Action definition.
        readonly details: OperationDetails;
      } & (
        | { readonly outcome: InvocationOutcome; readonly invocationId: string }
        | {
            readonly outcome:
              { readonly status: 'not-found' } | RejectedOutcome;
            readonly invocationId?: never;
          }
      ))
    | {
        readonly kind: 'adopt';
        readonly definitionId: string;
        readonly target?: ActivityObjectRef; // Present once membership is known.
        readonly outcome:
          { readonly status: 'ok' } | RejectedOutcome | UncertainOutcome;
        readonly details: OperationDetails;
      }
    | ({
        readonly kind: 'refresh';
        readonly definitionId: string;
        readonly target: ActivityObjectRef;
      } & (
        | {
            readonly outcome: { readonly status: 'ok' };
            readonly details: OperationDetails & {
              readonly refresh: 'changed' | 'unchanged' | 'superseded';
            };
          }
        | {
            readonly outcome: RejectedOutcome | UncertainOutcome;
            readonly details: OperationDetails & { readonly refresh?: never };
          }
      ))
  );

export interface Change {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly position: string; // Opaque in the protocol; bigint in Postgres.
  readonly graphId: string;
  readonly definitionRevision: string;
  readonly kind: 'created' | 'adopted' | 'updated' | 'deleted' | 'restored';
  readonly object: ActivityObjectRef;
  readonly changedPropertyIds: readonly string[];
  /** The attempt that committed this change; its operation row may not exist. */
  readonly operationId: string;
  readonly parentOperationId?: string;
  /** Native changes only; independent source changes do not inherit an invocation ID. */
  readonly invocationId?: string;
  readonly actor: ActivityActor;
  /** Required for source-refresh, absent otherwise; a principal or system actor. */
  readonly triggeredBy?: ActivityActor;
  readonly context: OperationContext;
  readonly occurredAt: string;
  readonly recordedAt: string;
  /** Present exactly for source-backed changes: adoption or source refresh. */
  readonly sourceDefinitionId?: string;
}

interface InvocationEventEnvelope {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly position: string;
  readonly graphId: string;
  readonly definitionRevision: string;
  readonly actionDefinitionId: string;
  readonly invocationId: string;
  readonly operationId: string;
  readonly actor: ActivityActor;
  readonly context: OperationContext;
  readonly occurredAt: string;
  readonly recordedAt: string;
}

export type InvocationEvent = InvocationEventEnvelope &
  (
    | { readonly kind: 'invocation-succeeded'; readonly failureCode?: never }
    | { readonly kind: 'invocation-failed'; readonly failureCode: string }
  );

/** One publication order; `kind` values are disjoint across the two types. */
export type FeedEntry = Change | InvocationEvent;

/** Stored on the object row; independent of feed and operation retention. */
export type ObjectProvenance =
  | {
      readonly kind: 'created';
      readonly actor: ActivityActor;
      readonly at: string;
      readonly invocationId: string;
    }
  | {
      readonly kind: 'adopted';
      readonly actor: ActivityActor;
      readonly at: string;
      readonly sourceDefinitionId: string;
    }
  | { readonly kind: 'unknown' }; // Legacy rows created before this spec.

export interface ActivityFilter {
  readonly actor?: ActivityActor;
  readonly objectDefinitionId?: string;
  readonly object?: ActivityObjectRef;
  readonly invocationId?: string;
  readonly operationId?: string;
  readonly requestId?: string;
  readonly from?: string; // Inclusive occurredAt/startedAt, RFC 3339.
  readonly to?: string;
}

export interface FeedFilter extends ActivityFilter {
  readonly kinds?: readonly FeedEntry['kind'][];
  readonly sourceDefinitionId?: string; // Source-backed changes only.
  readonly actionDefinitionId?: string; // Invocation events only.
}

export interface OperationFilter extends ActivityFilter {
  readonly kinds?: readonly Operation['kind'][];
  readonly objectRole?: OperationObject['role']; // Requires object or objectDefinitionId.
  readonly outcomes?: readonly OperationOutcome['status'][];
}

export interface ActivityPage<T> {
  readonly entries: readonly T[];
  readonly nextCursor: string;
  readonly hasMore: boolean;
}

// Filters are supplied only when beginning a page sequence.
export type ActivityReadOptions<Filter> = (
  | { readonly filter?: Filter; readonly cursor?: never }
  | { readonly cursor: string; readonly filter?: never }
) & { readonly limit?: number };

export type ActivityStatus =
  | { readonly state: 'unsupported' }
  | {
      readonly state: 'available';
      readonly durability: 'volatile' | 'persistent';
      readonly operationCapture: 'enabled' | 'disabled';
    };

export interface ActivityReader {
  status(): Promise<ActivityStatus>;
  readonly feed: {
    /** Oldest publication first: changes and invocation events. */
    read(
      options?: ActivityReadOptions<FeedFilter>,
    ): Promise<ActivityPage<FeedEntry>>;
  };
  readonly operations: {
    /** Newest recorded first; best-effort rows, no feed semantics. */
    list(
      options?: ActivityReadOptions<OperationFilter>,
    ): Promise<ActivityPage<Operation>>;
  };
}

export class ActivityError extends Error {
  constructor(
    readonly code:
      | 'unsupported'
      | 'unavailable'
      | 'invalid-request'
      | 'invalid-cursor'
      | 'cursor-expired',
  ) {
    super(`Activity ${code}`);
    this.name = 'ActivityError';
  }
}
