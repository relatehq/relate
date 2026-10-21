export type Json =
  null | boolean | number | string | Json[] | { [key: string]: Json };

export type EvidenceMode = 'compact' | 'full';

/** Shared controls, including restricted traversal and transaction reads. */
export interface ReadControls {
  /** Evidence presentation only; defaults to compact. */
  readonly evidence?: EvidenceMode;
  readonly select?: readonly string[];
  readonly maxAgeMs?: number;
  readonly refresh?: boolean;
  readonly stale?: 'allow' | 'omit';
  readonly requireComplete?: boolean;
  readonly timeoutMs?: number;
}

/** Object reads have their own extension point, separate from traversal. */
export interface ObjectReadRequest extends ReadControls {}

/** Existing public name retained for object reads. */
export type ReadRequest = ObjectReadRequest;

/** Exhaustion and continuation are mutually exclusive, including on the wire. */
export type PageMeta =
  | { readonly exhausted: true; readonly continuationCursor?: never }
  | { readonly exhausted: false; readonly continuationCursor: string };

/** Empty pages can still have a continuation. Records retain their evidence. */
export interface Page<T> {
  readonly data: readonly T[];
  readonly meta: PageMeta;
}

/** Await one page, or iterate records across pages. */
export interface QueryResult<T>
  extends PromiseLike<Page<T>>, AsyncIterable<T> {}

export type Refresh =
  'not-needed' | 'succeeded' | 'unavailable' | 'invalid' | 'superseded';

/**
 * Why a selected field has no value, when it has none.
 *
 * - `forbidden`: the field is known and the caller's roles do not grant its
 *   access group. The answer is final for this principal; it reveals only the
 *   caller's own role membership, never object-level policy evidence.
 * - `unavailable`: the field may be readable, but no value could be supplied:
 *   an unknown name, an omitted stale value, or a reference whose target
 *   cannot be disclosed. Hidden and deleted targets share this shape.
 *
 * Whole-object denial stays `not-found` and never reaches field evidence.
 */
export type FieldEvidence =
  | { status: 'forbidden' }
  | { status: 'unavailable' }
  | {
      status: 'available' | 'absent';
      freshness: 'fresh' | 'stale';
      observedAt: string;
      source: 'native' | 'source';
      sourceDefinitionId?: string;
      orderingBasis?: 'source-version' | 'fetch-start';
      retention: 'confirmed' | 'failed' | 'unconfirmed';
      retentionDurability: 'volatile' | 'persistent';
      ordering: 'confirmed' | 'unconfirmed';
      refresh: Refresh;
    };

export type EvidenceWarning =
  'observation_not_retained' | 'retention_unconfirmed' | 'ordering_unconfirmed';

interface ReadSummary {
  completeness: 'complete' | 'partial';
  degraded: boolean;
  definitionRevision: string;
}

export interface FullReadMeta extends ReadSummary {
  evidence: 'full';
  fields: Record<string, FieldEvidence>;
  warnings: EvidenceWarning[];
}

export interface CompactReadMeta extends ReadSummary {
  evidence: 'compact';
  /** Only exceptional fields. Omitted when there are none. */
  fields?: Record<string, FieldEvidence>;
  /** Nonempty warnings are always preserved. */
  warnings?: EvidenceWarning[];
}

export type ReadMeta = FullReadMeta | CompactReadMeta;

export type ReadResult =
  | { status: 'not-found' }
  | { status: 'ok'; data: Record<string, Json>; meta: ReadMeta };

/** Complete evidence used during resolution, before response presentation. */
export type FullReadResult =
  | { status: 'not-found' }
  | { status: 'ok'; data: Record<string, Json>; meta: FullReadMeta };

export interface FullObjectRecord {
  readonly id: string;
  readonly data: Record<string, Json>;
  readonly meta: FullReadMeta;
}

export type FullObjectResult =
  | { readonly status: 'not-found' }
  | ({ readonly status: 'ok' } & FullObjectRecord);

export type FullPageResult = Page<FullObjectRecord>;

export interface ObjectRecord {
  readonly id: string;
  readonly data: Extract<ReadResult, { status: 'ok' }>['data'];
  readonly meta: Extract<ReadResult, { status: 'ok' }>['meta'];
}

export type ObjectResult =
  { readonly status: 'not-found' } | ({ readonly status: 'ok' } & ObjectRecord);

/** Pages enumerate adopted graph members, not provider-wide coverage. */
export type PageResult = Page<ObjectRecord>;

/** Scalar predicate operands remain JSON scalars on every transport. */
export type FilterScalar = string | number | boolean | null;

export interface FilterOperators {
  readonly eq?: FilterScalar;
  readonly in?: readonly FilterScalar[];
  readonly gt?: string | number;
  readonly gte?: string | number;
  readonly lt?: string | number;
  readonly lte?: string | number;
}

/**
 * Collection reads page and filter. Filters address the returned object's
 * properties; schema-specific operators are validated by the runtime. A to-one
 * traversal accepts neither paging nor filters.
 */
export interface CollectionReadControls extends ReadControls {
  readonly limit?: number;
  readonly cursor?: string;
  readonly where?: Readonly<Record<string, FilterScalar | FilterOperators>>;
}

/** Traversal never inherits object-only analytical options. */
export interface TraversalRequest extends CollectionReadControls {}

/** A query pages and filters graph members of one object type. */
export interface ObjectQueryRequest
  extends ObjectReadRequest, CollectionReadControls {}

/** Existing public name retained for object queries. */
export type QueryRequest = ObjectQueryRequest;

/**
 * One problem with a caller's read request. Paths name request options, filter
 * properties or arguments; the reader could already see every name listed, so
 * an issue never reveals a hidden field, traversal or record.
 */
export interface RequestIssue {
  readonly path: readonly string[];
  readonly problem:
    | 'unknown-option'
    | 'invalid-value'
    | 'unknown-property'
    | 'unknown-traversal'
    | 'invalid-cursor'
    | 'not-supported';
  readonly message: string;
  /** Names the reader may use instead, when that list is useful. */
  readonly accepted?: readonly string[];
}

export interface ReadErrorDetails {
  /** The called operation, such as `Person.query` or `Playlist.traverse.songs`. */
  readonly operation: string;
  readonly issues: readonly RequestIssue[];
  /** Every option the operation accepts, listed when an option was unknown. */
  readonly acceptedOptions?: readonly string[];
}

function readErrorMessage(code: string, details?: ReadErrorDetails) {
  if (!details) return code;

  return [
    `${code} in ${details.operation}:`,
    ...details.issues.map(
      (issue) => `- ${issue.path.join('.') || 'request'}: ${issue.message}`,
    ),
    ...(details.acceptedOptions
      ? [`Accepted options: ${details.acceptedOptions.join(', ')}.`]
      : []),
  ].join('\n');
}

/**
 * `runtime-retired`: the request was addressed to a runtime that has since been
 * replaced (for example after a development reload). It was not executed and is
 * never replayed against the replacement; rebind and decide whether to retry.
 */
export class ReadError extends Error {
  readonly operation?: string;
  readonly issues: readonly RequestIssue[];
  readonly acceptedOptions?: readonly string[];

  constructor(
    readonly code:
      'incomplete' | 'invalid-request' | 'unavailable' | 'runtime-retired',
    details?: ReadErrorDetails,
  ) {
    super(readErrorMessage(code, details));
    this.name = 'ReadError';
    this.issues = Object.freeze(
      (details?.issues ?? []).map((issue) =>
        Object.freeze({
          ...issue,
          path: Object.freeze([...issue.path]),
          ...(issue.accepted
            ? { accepted: Object.freeze([...issue.accepted]) }
            : {}),
        }),
      ),
    );

    if (details) this.operation = details.operation;

    if (details?.acceptedOptions)
      this.acceptedOptions = Object.freeze([...details.acceptedOptions]);
  }
}

export interface SucceededReceipt<Output = Json> {
  readonly invocationId: string;
  readonly state: 'succeeded';
  readonly output: Output;
}

export interface FailedReceipt<Code extends string = string, Details = Json> {
  readonly invocationId: string;
  readonly state: 'failed';
  readonly error: {
    readonly kind: 'domain';
    readonly code: Code;
    readonly details: Details;
  };
}

export type ActionReceipt = SucceededReceipt | FailedReceipt;

/**
 * Request/execution rejection, not a persisted failed receipt. No private details.
 * `runtime-retired` means the action was not started because its runtime was
 * replaced; it is never replayed against the replacement.
 */
export class ActionError extends Error {
  constructor(
    readonly code:
      | 'denied'
      | 'not-found'
      | 'invalid'
      | 'conflict'
      | 'unsupported'
      | 'unavailable'
      | 'internal'
      | 'uncertain'
      | 'runtime-retired',
  ) {
    super(code);
    this.name = 'ActionError';
  }
}

export { present } from './presentation.js';
export type { Presentable, Presented } from './presentation.js';

export type {
  ActionDescription,
  ActionFieldDescription,
  ActionSummary,
  ActionOverview,
  Discovery,
  GraphDescription,
  ObjectDescription,
  ObjectSummary,
  ObjectOverview,
  SdkDescription,
  SdkOptionDescription,
  ReadOperation,
  TraversalOverview,
  OptionDescription,
  PropertyDescription,
  ScalarSchema,
  TraversalDescription,
} from './discovery.js';

export type { ConsumerOperations } from './consumer.js';

export { ActivityError } from './activity.js';

export type {
  ActivityActor,
  ActivityFilter,
  ActivityObjectRef,
  ActivityPage,
  ActivityReader,
  ActivityReadOptions,
  ActivityStatus,
  ActivityTransport,
  Change,
  FeedEntry,
  FeedEntryKind,
  FeedFilter,
  InvocationEvent,
  InvocationOutcome,
  ObjectProvenance,
  Operation,
  OperationActor,
  OperationContext,
  OperationDetails,
  OperationFilter,
  OperationKind,
  OperationObject,
  OperationOutcome,
  RejectedOutcome,
  UncertainOutcome,
} from './activity.js';
