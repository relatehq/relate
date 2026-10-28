import type { ActionError, ReadError } from './index.js';

type ReadErrorCode = ReadError['code'];

type ActionErrorCode = ActionError['code'];

export type ActivityActor =
  | { readonly kind: 'principal'; readonly id: string }
  | { readonly kind: 'system'; readonly id: string }
  /** A source system observed to have changed; id is the source definition ID. */
  | { readonly kind: 'source'; readonly id: string };

/** An actor that can attempt an operation; sources are only observed. */
export type OperationActor = Exclude<ActivityActor, { kind: 'source' }>;

export type ActivityTransport = 'embedded' | 'http' | 'mcp';

export interface OperationContext {
  readonly requestId: string;
  readonly transport: ActivityTransport;
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
  /** Stable property definition IDs. */
  readonly returned: readonly string[];
  readonly forbidden: readonly string[];
  readonly unavailable: readonly string[];
}

export type OperationOutcome =
  | { readonly status: 'ok' | 'not-found' }
  | { readonly status: 'succeeded' }
  /** A declared domain failure. */
  | { readonly status: 'failed'; readonly code: string }
  | {
      readonly status: 'rejected';
      readonly code: ReadErrorCode | Exclude<ActionErrorCode, 'uncertain'>;
    }
  | { readonly status: 'uncertain' };

export type RejectedOutcome = Extract<OperationOutcome, { status: 'rejected' }>;

export type UncertainOutcome = Extract<
  OperationOutcome,
  { status: 'uncertain' }
>;

export type InvocationOutcome = Extract<
  OperationOutcome,
  { status: 'succeeded' | 'failed' }
>;

type ReadOutcome = { readonly status: 'ok' | 'not-found' } | RejectedOutcome;

interface OperationEnvelope {
  readonly schemaVersion: 1;
  /** Fresh per attempt; not `ActionContext.idempotencyId`. */
  readonly id: string;
  readonly parentOperationId?: string;
  readonly graphId: string;
  readonly definitionRevision: string;
  readonly actor: ActivityActor;
  readonly context: OperationContext;
  /** RFC 3339. */
  readonly startedAt: string;
  readonly completedAt: string;
  /** Monotonic duration. */
  readonly durationMs: number;
  readonly recordedAt: string;
  /** In result order. */
  readonly objects: readonly OperationObject[];
}

/** Fixed host diagnostics; never consumer result metadata. */
export const analyticalTimingStages = [
  'preparation',
  'candidates',
  'dependencyReads',
  'planning',
  'queueWait',
  'connectionStartup',
  'execution',
  'revalidation',
  'finalization',
] as const;

export type AnalyticalTimingStage = (typeof analyticalTimingStages)[number];

export interface StageTiming {
  readonly count: number;
  readonly totalMs: number;
  readonly maxMs: number;
}

export interface AnalyticalTimings {
  /** Summed work durations can overlap and are not additive elapsed time. */
  readonly stages: Partial<Record<AnalyticalTimingStage, StageTiming>>;
}

export const analyticalFailureReasons = [
  'forbidden',
  'correlation-unavailable',
  'execution-failed',
  'invalid-result',
  'busy',
  'interrupted',
] as const;

export type AnalyticalFailureReason = (typeof analyticalFailureReasons)[number];

export const analyticalSummaryLimits = {
  maxCalculations: 32,
  maxIdentifierBytes: 256,
} as const;

export interface AnalyticalCalculationSummary {
  readonly associationId: string;
  readonly datasetId: string;
  /** Declared calculations only; caller aliases are never recorded. */
  readonly propertyId?: string;
  /** Failed object results observed across the evaluated scope, not repeated checks. */
  readonly failures: Partial<Record<AnalyticalFailureReason, number>>;
}

export interface AnalyticalSummary {
  readonly expressionCount: number;
  readonly computedFilter: boolean;
  readonly computedOrder: boolean;
  readonly calculations: readonly AnalyticalCalculationSummary[];
  /** Entries omitted for count or identifier-size bounds. IDs are never shortened. */
  readonly omittedCalculations?: number;
}

export interface AnalyticalActivity extends AnalyticalTimings {
  /** Present after successful expression preparation; no SQL, values or aliases. */
  readonly summary?: AnalyticalSummary;
}

export interface OperationDetails {
  /** Host-only analytical work summary, present only for analytical get/query. */
  readonly analytical?: AnalyticalActivity;
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
        /** Result object definition, even for an empty page. */
        readonly definitionId: string;
        readonly outcome: { readonly status: 'ok' } | RejectedOutcome;
        readonly details: OperationDetails & { readonly hasMore?: boolean };
      }
    | {
        readonly kind: 'traverse';
        /** Result object definition. */
        readonly definitionId: string;
        readonly outcome: ReadOutcome;
        readonly details: OperationDetails & {
          readonly traversalId: string;
          readonly from: ActivityObjectRef;
          readonly hasMore?: boolean;
        };
      }
    | ({
        readonly kind: 'invoke';
        /** Action definition. */
        readonly definitionId: string;
        readonly details: OperationDetails;
      } & InvocationAttempt)
    | ({
        readonly kind: 'receipt';
        /** Action definition. */
        readonly definitionId: string;
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
        /** Present once membership is known. */
        readonly target?: ActivityObjectRef;
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

export type OperationKind = Operation['kind'];

export interface Change {
  readonly schemaVersion: 1;
  readonly id: string;
  /** Opaque in the protocol; bigint in Postgres. */
  readonly position: string;
  readonly graphId: string;
  readonly definitionRevision: string;
  readonly kind: 'created' | 'adopted' | 'updated' | 'deleted' | 'restored';
  readonly object: ActivityObjectRef;
  readonly changedPropertyIds: readonly string[];
  /** The attempt that committed this change; its operation row may not exist. */
  readonly operationId: string;
  readonly parentOperationId?: string;
  /**
   * The invocation that committed this change: required for native changes,
   * present on source changes accepted by an action's transaction, and absent
   * on independent host adoptions and refreshes.
   */
  readonly invocationId?: string;
  readonly actor: ActivityActor;
  /** Required for source-refresh, absent otherwise; a principal or system actor. */
  readonly triggeredBy?: OperationActor;
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
  readonly actor: OperationActor;
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

export type FeedEntryKind = FeedEntry['kind'];

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
      /** The adopting action invocation; absent for host and legacy adoption. */
      readonly invocationId?: string;
    }
  /** Legacy rows created before activity recording. */
  | { readonly kind: 'unknown' };

export interface ActivityFilter {
  readonly actor?: ActivityActor;
  readonly objectDefinitionId?: string;
  readonly object?: ActivityObjectRef;
  readonly invocationId?: string;
  readonly operationId?: string;
  readonly requestId?: string;
  /** Inclusive occurredAt (feed) or startedAt (operations), RFC 3339. */
  readonly from?: string;
  readonly to?: string;
}

export interface FeedFilter extends ActivityFilter {
  readonly kinds?: readonly FeedEntryKind[];
  /** Source-backed changes only. */
  readonly sourceDefinitionId?: string;
  /** Invocation events only. */
  readonly actionDefinitionId?: string;
}

export interface OperationFilter extends ActivityFilter {
  readonly kinds?: readonly OperationKind[];
  /** Requires object or objectDefinitionId. */
  readonly objectRole?: OperationObject['role'];
  readonly outcomes?: readonly OperationOutcome['status'][];
}

/**
 * A checkpointed page. Unlike `Page<T>`, `nextCursor` advances over the
 * scanned range even when no matching entry is returned.
 */
export interface ActivityPage<T> {
  readonly entries: readonly T[];
  readonly nextCursor: string;
  readonly hasMore: boolean;
}

/** Filters are supplied only when beginning a page sequence. */
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

/**
 * Activity reading rejection. `unsupported` is never an empty history;
 * `cursor-expired` means retained history no longer covers the checkpoint.
 */
export class ActivityError extends Error {
  constructor(
    readonly code:
      | 'unsupported'
      | 'unavailable'
      | 'invalid-request'
      | 'invalid-cursor'
      | 'cursor-expired',
    options?: ErrorOptions,
  ) {
    super(code, options);
    this.name = 'ActivityError';
  }
}
