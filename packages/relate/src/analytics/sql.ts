/** Offsets are zero-based UTF-16 indices into the original caller SQL. */
export interface SourceSpan {
  readonly start: number;
  readonly end: number;
}

export interface Name {
  readonly name: string;
  readonly quoted: boolean;
  readonly at: SourceSpan;
}

/** Numeric spelling stays exact until contextual type resolution. */
export type LiteralOperand = {
  readonly kind: 'literal';
  readonly at: SourceSpan;
} & (
  | { readonly literal: 'number' | 'string'; readonly value: string }
  | { readonly literal: 'boolean'; readonly value: boolean }
  | { readonly literal: 'null'; readonly value: null }
);

export type Operand =
  | ({ readonly kind: 'column' | 'self' } & Name)
  | {
      readonly kind: 'parameter';
      readonly name: string;
      readonly at: SourceSpan;
    }
  | LiteralOperand;

export type Predicate =
  | {
      readonly kind: 'compare';
      readonly op: '=' | '<>' | '>' | '>=' | '<' | '<=';
      readonly left: Operand;
      readonly right: Operand;
    }
  | {
      readonly kind: 'boolean';
      readonly op: 'and' | 'or' | 'not';
      readonly args: readonly Predicate[];
    }
  | { readonly kind: 'null'; readonly value: Operand; readonly not: boolean };

export type Aggregate = 'count' | 'sum' | 'avg' | 'min' | 'max';

export type ArithmeticOperator = '+' | '-' | '*' | '/';

/** Arithmetic evaluated separately for each eligible row of an aggregate. */
export type RowExpression<O = Operand, N = { readonly at: SourceSpan }> =
  O | RowNode<O, N>;

/** `N` carries stage-specific node data: source spans, then resolved types. */
export type RowNode<O = Operand, N = { readonly at: SourceSpan }> = N & {
  readonly kind: 'arithmetic';
  readonly op: ArithmeticOperator;
  readonly left: RowExpression<O, N>;
  readonly right: RowExpression<O, N>;
};

/** A numeric formula over aggregate leaves `A` and scalar operand leaves `O`. */
export type ScalarExpression<A, O = Operand> =
  ScalarLeaf<A, O> | ScalarNode<A, O>;

export type ScalarLeaf<A, O = Operand> =
  | { readonly kind: 'aggregate'; readonly value: A }
  | { readonly kind: 'operand'; readonly value: O };

export type ScalarNode<A, O = Operand> =
  | {
      readonly kind: 'binary';
      readonly op: ArithmeticOperator;
      readonly left: ScalarExpression<A, O>;
      readonly right: ScalarExpression<A, O>;
    }
  | {
      readonly kind: 'nullif' | 'coalesce';
      readonly left: ScalarExpression<A, O>;
      readonly right: ScalarExpression<A, O>;
    };

export type RelateSqlQuery = { readonly association: Name } & (
  | SqlAggregate
  | {
      readonly aggregate: 'expression';
      readonly expression: ScalarExpression<SqlAggregate>;
    }
);

export interface SqlAggregate {
  readonly aggregate: Aggregate;
  readonly argument: RowExpression | '*';
  readonly distinct: boolean;
  readonly predicate?: Predicate;
  readonly fallback?: LiteralOperand;
}

export interface SqlIssue {
  readonly problem: 'invalid-value' | 'not-supported';
  readonly message: string;
  readonly at?: SourceSpan;
}

export type ParseResult =
  | { readonly ok: true; readonly query: RelateSqlQuery }
  | { readonly ok: false; readonly issues: readonly SqlIssue[] };

/** The Node composition root initializes the implementation before requests. */
export interface SqlParser {
  readonly grammarVersion: number;
  parse(sql: string): ParseResult;
}
