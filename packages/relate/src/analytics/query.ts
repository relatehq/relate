import type { ComputedResultType, LogicalType } from '@relate/protocol';
import type {
  Aggregate,
  Predicate,
  RowExpression,
  ScalarExpression,
} from './sql.js';
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

/** Checked row arithmetic; every node carries its inferred numeric type. */
export type ResolvedRowExpression = RowExpression<
  ResolvedOperand,
  { readonly type: { readonly type: 'int64' | 'float64' } }
>;

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

export type ResolvedScalarExpression = ScalarExpression<
  ResolvedAggregateLeaf,
  ResolvedOperand
>;

export type ResolvedAggregate =
  | ResolvedAggregateLeaf
  | {
      readonly aggregate: 'expression';
      readonly expression: ResolvedScalarExpression;
      readonly result: ComputedResultType;
    };

export interface ResolvedAggregateLeaf {
  readonly aggregate: Aggregate;
  readonly argument: ResolvedRowExpression | '*';
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
