import type {
  FieldEvidence,
  ComputedUnavailableReason,
} from '@relate/protocol';
import type { AnalyticalScalar, ResultType } from 'relate/analytics';
import type {
  AnalyticalConnector,
  DatasetResource,
  TypedValue,
} from 'relate/connectors';
import type { ResolvedExpression } from './types.js';
import type { StatementQueue } from './queue.js';

/** Both caller aliases and normalized declarations enter this execution contract. */
export interface ResolvedCalculation {
  readonly name: string;
  readonly definitionId?: string;
  readonly project: boolean;
  readonly required: boolean;
  readonly expression: ResolvedExpression;
  readonly readable: boolean;
}

export interface AuthorizedCandidate {
  readonly id: string;
  readonly dependencies: Readonly<
    Record<
      string,
      { readonly value?: TypedValue; readonly evidence: FieldEvidence }
    >
  >;
}

export interface AnalyticalBinding {
  readonly resource: DatasetResource;
  readonly connector: AnalyticalConnector;
  readonly queue: StatementQueue;
  readonly bindingRevision: string;
}

export type ComputedField =
  | { readonly status: 'forbidden' }
  | {
      readonly status: 'unavailable';
      readonly reason: ComputedUnavailableReason;
      readonly retryable?: boolean;
    }
  | {
      readonly status: 'available';
      readonly value: AnalyticalScalar;
      readonly computedAt: string;
      readonly input: {
        readonly associationId: string;
        readonly datasetId: string;
        readonly bindingRevision: string;
        readonly readAt: string;
        readonly modifiedAt?: string;
      };
      /** Exact ordinary values and evidence used; retained for final revalidation. */
      readonly dependencies: AuthorizedCandidate['dependencies'];
    };

export interface ComputedScope {
  readonly rows: ReadonlyMap<string, Readonly<Record<string, ComputedField>>>;
  /** Projection metadata only; filter/order-only declarations remain internal. */
  readonly results: Readonly<Record<string, ResultType>>;
}

export class AnalyticalIncompleteError extends Error {
  constructor(
    readonly fields: Readonly<
      Record<string, Exclude<ComputedField, { status: 'available' }>>
    >,
  ) {
    super('Required analytical fields could not be supplied');
    this.name = 'AnalyticalIncompleteError';
  }
}
