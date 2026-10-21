import type { ComputedResultType, LogicalType } from '@relate/protocol';
import type { ResourceConnection } from '../connectors.js';
import type { Aggregate, Predicate } from './sql.js';
import type { TypedValue } from './values.js';

declare const datasetResource: unique symbol;
declare const preparedPlan: unique symbol;

/** Connector-owned identity. Physical names and mappings stay behind this handle. */
export interface DatasetResource {
  readonly [datasetResource]: true;
}

/** Connector-owned, resource-specific plan. Never accepted from a caller or wire. */
export interface PreparedPlan {
  readonly [preparedPlan]: true;
}

export type ResolvedOperand =
  | {
      readonly kind: 'column';
      readonly column: string;
      readonly type: LogicalType;
    }
  | { readonly kind: 'key'; readonly key: number; readonly type: LogicalType }
  | { readonly kind: 'value'; readonly value: TypedValue };

export type ResolvedPredicate =
  | {
      readonly kind: 'compare';
      readonly op: Extract<Predicate, { kind: 'compare' }>['op'];
      readonly left: ResolvedOperand;
      readonly right: ResolvedOperand;
    }
  | {
      readonly kind: 'boolean';
      readonly op: 'and' | 'or' | 'not';
      readonly args: readonly ResolvedPredicate[];
    }
  | {
      readonly kind: 'null';
      readonly value: ResolvedOperand;
      readonly not: boolean;
    };

export interface ResolvedAggregate {
  readonly aggregate: Aggregate;
  readonly argument: ResolvedOperand | '*';
  readonly distinct: boolean;
  readonly predicate?: ResolvedPredicate;
  readonly fallback?: TypedValue;
  readonly result: ComputedResultType;
}

/** Runtime-produced, actor-authorized statement input; all names are declared names. */
export interface AuthorizedDatasetQuery {
  readonly resource: DatasetResource;
  /** Correlation properties first, then every ordinary self property used. */
  readonly keys: readonly { readonly type: LogicalType }[];
  readonly correlation: readonly {
    readonly column: string;
    readonly key: number;
  }[];
  readonly slots: readonly {
    readonly values: readonly TypedValue[];
    /** One mask per aggregate: false means an unavailable dependency. */
    readonly valid: readonly boolean[];
  }[];
  readonly aggregates: readonly ResolvedAggregate[];
}

/** Types the physical column can represent without loss under this connector. */
export interface PhysicalColumn {
  readonly supportedTypes: readonly LogicalType[];
  readonly nullable: boolean;
  /** Backend type description for startup diagnostics, never query evidence. */
  readonly databaseType: string;
}

export interface PhysicalSchema {
  /** Declared names; a missing physical column is absent from this map. */
  readonly columns: Readonly<Record<string, PhysicalColumn>>;
}

export interface SlotRow {
  readonly slot: number;
  /** One losslessly decoded scalar per aggregate. No driver wrappers or Dates. */
  readonly values: readonly (string | number | bigint | boolean | null)[];
}

export interface DatasetExecution {
  /** Exactly one row per input slot, in slot order. */
  readonly rows: readonly SlotRow[];
  /** Connector clock at statement execution, after admission and client startup. */
  readonly readAt: string;
  /** Backend observation, not a snapshot identity or ingestion watermark. */
  readonly modifiedAt?: string;
}

export interface AnalyticalConnector {
  readonly limits: { readonly maxParameters: number };
  describe(
    resource: DatasetResource,
    options: { signal: AbortSignal },
  ): Promise<PhysicalSchema>;
  /** Pure conservative bound including all masks, literals and generated values. */
  parameterBudget(query: Omit<AuthorizedDatasetQuery, 'slots'>): {
    readonly fixed: number;
    readonly perSlot: number;
  };
  /** Pure and synchronous; checks the generated parameter count against the limit. */
  plan(query: AuthorizedDatasetQuery): PreparedPlan;
  /** Settles only after statement resources are released, including on abort. */
  execute(
    plan: PreparedPlan,
    options: { signal: AbortSignal; timeoutMs: number },
  ): Promise<DatasetExecution>;
}

/** The configured connection owns disposal; the capability has no close method. */
export interface AnalyticalConnection extends ResourceConnection {
  readonly analytics: AnalyticalConnector;
}

/** Binding selection uses declared names as keys and physical names as values. */
export interface DatasetSelection {
  readonly columns: Readonly<Record<string, string>>;
}

/** A selected resource may implement both this capability and keyed source reads. */
export interface AnalyticalResource {
  readonly connection: AnalyticalConnection;
  readonly resourceId: string;
  bindDataset(selection: DatasetSelection): DatasetResource;
}

/** Driver causes remain internal; public failure messages never contain driver text. */
export class DatasetExecutionError extends Error {
  readonly code: 'execution-failed' | 'invalid-result';
  readonly retryable: boolean;

  constructor(
    code: 'execution-failed' | 'invalid-result',
    options: { readonly retryable: boolean; readonly cause?: unknown },
  ) {
    super(
      code === 'invalid-result'
        ? 'Invalid analytical result'
        : 'Analytical execution failed',
      options.cause === undefined ? undefined : { cause: options.cause },
    );
    this.name = 'DatasetExecutionError';
    this.code = code;
    this.retryable = options.retryable;
  }
}
