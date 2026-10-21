import type { Json } from './index.js';

/** Logical scalar types are independent of database driver representations. */
export type LogicalType =
  | { readonly type: 'boolean' | 'string' | 'int32' | 'int64' | 'float64' }
  | { readonly type: 'timestamp'; readonly precision: 3 | 6 };

/** Result metadata is stable even when a particular value is omitted. */
export type ComputedResultType = LogicalType & { readonly nullable: boolean };

export interface AnalyticalExpression {
  readonly sql: string;
  readonly parameters?: Readonly<Record<string, Json>>;
}

export interface OrderEntry {
  readonly field: string;
  readonly direction: 'asc' | 'desc';
}

export type ComputedUnavailableReason =
  'correlation-unavailable' | 'execution-failed' | 'invalid-result' | 'busy';
