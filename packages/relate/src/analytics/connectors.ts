import type { LogicalType } from '@relate/protocol';
import type { ResourceConnection } from '../connectors.js';
import type {
  AuthorizedDatasetQuery,
  DatasetResource,
  PreparedPlan,
} from './query.js';

export type {
  AuthorizedDatasetQuery,
  DatasetResource,
  PreparedPlan,
  ResolvedOperand,
  ResolvedRowExpression,
  ResolvedPredicate,
  ResolvedAggregate,
  ResolvedAggregateLeaf,
  ResolvedScalarExpression,
} from './query.js';

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
  /** Exactly one entry per value; all false for an unused or invalid field mask. */
  readonly checks: readonly SlotCheck[];
}

/** Per-cell execution checks; a failed cell carries a null placeholder value. */
export interface SlotCheck {
  /** A row operation or accumulation of this cell's eligible rows left its type's range. */
  readonly arithmeticFailed: boolean;
}

export interface DatasetExecution {
  /** Exactly one row per input slot, in slot order. */
  readonly rows: readonly SlotRow[];
  /** Connector clock at statement execution, after admission and client startup. */
  readonly readAt: string;
  /** Backend observation, not a snapshot identity or ingestion watermark. */
  readonly modifiedAt?: string;
}

/** Host-only connector timing; observer failures never affect execution. */
export interface AnalyticalExecutionTiming {
  readonly stage: 'connectionStartup' | 'execution';
  readonly durationMs: number;
}

export interface AnalyticalConnector {
  readonly limits: {
    readonly maxParameters: number;
    readonly maxConcurrentStatements?: number;
  };
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
    options: {
      signal: AbortSignal;
      timeoutMs: number;
      onTiming?: (timing: AnalyticalExecutionTiming) => void;
    },
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
