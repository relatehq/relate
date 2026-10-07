export type Json =
  null | boolean | number | string | Json[] | { [key: string]: Json };

export interface ReadRequest {
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

export type Refresh =
  'not-needed' | 'succeeded' | 'unavailable' | 'invalid' | 'superseded';

export type FieldEvidence =
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

export type ReadResult =
  | { status: 'not-found' }
  | {
      status: 'ok';
      data: Record<string, Json>;
      meta: {
        completeness: 'complete' | 'partial';
        degraded: boolean;
        definitionRevision: string;
        fields: Record<string, FieldEvidence>;
        warnings: (
          | 'observation_not_retained'
          | 'retention_unconfirmed'
          | 'ordering_unconfirmed'
        )[];
      };
    };

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

/** Request/execution rejection, not a persisted failed receipt. No private details. */
export class ActionError extends Error {
  constructor(
    readonly code:
      | 'denied'
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
