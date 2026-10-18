/** Spike contracts only. No exports are added to Relate's public packages. */
export type Scalar = string | number | boolean | null;
export type LogicalType = 'string' | 'timestamp' | 'int64' | 'float64';

export interface Expression {
  sql: string;
  parameters?: Readonly<Record<string, Scalar>>;
}

export type Operand =
  | { kind: 'column'; name: string }
  | { kind: 'self'; name: string }
  | { kind: 'parameter'; name: string }
  | { kind: 'literal'; value: Scalar; type?: LogicalType };

export type Predicate =
  | {
      kind: 'compare';
      op: '=' | '<>' | '>' | '>=' | '<' | '<=';
      left: Operand;
      right: Operand;
    }
  | { kind: 'boolean'; op: 'and' | 'or' | 'not'; args: Predicate[] }
  | { kind: 'null'; value: Operand; not: boolean };

export interface SqlQuery {
  association: string;
  aggregate: 'count' | 'sum' | 'avg' | 'min' | 'max';
  argument: Operand | '*';
  distinct: boolean;
  predicate?: Predicate;
}

export interface Column {
  physical: string;
  type: LogicalType;
  readable: boolean;
}

/** Runtime supplies actor-filtered declarations; this is not a wire contract. */
export interface Association {
  name: string;
  table: string;
  columns: Record<string, Column>;
  properties: Record<string, { type: LogicalType; readable: boolean }>;
  on: Record<string, string>;
}

export interface ResolvedExpression {
  query: SqlQuery;
  values: Record<string, Scalar>;
  parameterTypes: Record<string, LogicalType>;
  type: LogicalType;
  nullable: boolean;
  dependencies: string[];
  forbidden: boolean;
}

export interface Candidate {
  id: string;
  /** Only authorized, fresh dependency values belong here. Missing means unavailable. */
  properties: Record<string, Scalar>;
}

export interface Statement {
  text: string;
  values: Scalar[];
}

export type Row = Record<string, unknown>;

export interface Backend {
  dialect: 'postgres' | 'sqlite';
  plan(
    association: Association,
    candidates: Candidate[],
    expressions: ResolvedExpression[],
  ): Statement;
  execute(
    statement: Statement,
    options: { signal: AbortSignal; timeoutMs: number },
  ): Promise<Row[]>;
}

export class SpikeError extends Error {
  constructor(
    readonly code:
      | 'invalid-request'
      | 'incomplete'
      | 'busy'
      | 'invalid-result'
      | 'execution-failed',
    readonly problem: string,
  ) {
    super(`${code}: ${problem}`);
  }
}

export function invalid(problem: string): never {
  throw new SpikeError('invalid-request', problem);
}
