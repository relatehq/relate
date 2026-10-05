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

export class ReadError extends Error {
  constructor(readonly code: 'incomplete' | 'invalid-request' | 'unavailable') {
    super(code);
    this.name = 'ReadError';
  }
}
