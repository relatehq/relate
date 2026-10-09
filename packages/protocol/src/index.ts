export type Json =
  null | boolean | number | string | Json[] | { [key: string]: Json };

export type EvidenceMode = 'compact' | 'full';

export interface ReadRequest {
  /** Evidence presentation only; defaults to compact. */
  readonly evidence?: EvidenceMode;
  readonly select?: readonly string[];
  readonly maxAgeMs?: number;
  readonly refresh?: boolean;
  readonly stale?: 'allow' | 'omit';
  readonly requireComplete?: boolean;
  readonly timeoutMs?: number;
}

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

export interface TraversalRequest extends ReadRequest {
  readonly limit?: number;
  readonly cursor?: string;
}

/** Equality filters address object properties, never provider columns. */
export interface QueryRequest extends TraversalRequest {
  readonly where?: Readonly<Record<string, Json>>;
}

export class ReadError extends Error {
  constructor(readonly code: 'incomplete' | 'invalid-request' | 'unavailable') {
    super(code);
    this.name = 'ReadError';
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

/** Request/execution rejection, not a persisted failed receipt. No private details. */
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
      | 'uncertain',
  ) {
    super(code);
    this.name = 'ActionError';
  }
}

export { present } from './presentation.js';
export type { Presentable, Presented } from './presentation.js';
