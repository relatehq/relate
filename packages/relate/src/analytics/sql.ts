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

export type ScalarExpression<T> =
  | { readonly kind: 'aggregate'; readonly value: T }
  | { readonly kind: 'operand'; readonly value: Operand }
  | {
      readonly kind: 'binary';
      readonly op: '+' | '-' | '*' | '/';
      readonly left: ScalarExpression<T>;
      readonly right: ScalarExpression<T>;
    }
  | {
      readonly kind: 'nullif' | 'coalesce';
      readonly left: ScalarExpression<T>;
      readonly right: ScalarExpression<T>;
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
  readonly argument: Operand | '*';
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
