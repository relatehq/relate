import type { PropertyColumn } from './model.js';

export type Scalar = bigint | number | string | boolean;
export type Comparison = '=' | '<>' | '!=' | '<' | '<=' | '>' | '>=';

/** A value written into the SQL text, or bound as a named parameter. */
export interface ValueOperand {
  readonly kind: 'value';
  readonly value: Scalar;
  /** SQL literal text; timestamps may use another spelling of the same instant. */
  readonly literal: string;
  readonly parameter: boolean;
}

export type Operand =
  | { readonly kind: 'column'; readonly column: PropertyColumn }
  | { readonly kind: 'since' }
  | ValueOperand;

export type Predicate =
  | {
      readonly kind: 'compare';
      readonly op: Comparison;
      readonly left: Operand;
      readonly right: Operand;
    }
  | {
      readonly kind: 'null';
      readonly column: PropertyColumn;
      readonly not: boolean;
    }
  | {
      readonly kind: 'boolean';
      readonly op: 'and' | 'or';
      readonly args: readonly Predicate[];
    }
  | { readonly kind: 'not'; readonly arg: Predicate };

export interface PropertyQuery {
  readonly aggregate: 'count' | 'sum' | 'avg' | 'min' | 'max';
  readonly argument: PropertyColumn | '*';
  readonly distinct: boolean;
  readonly predicate?: Predicate;
  /** Write columns as `e.name` rather than `name`. */
  readonly qualified: boolean;
}

/** Render Relate SQL text and its named parameters. */
export function renderQuery(query: PropertyQuery): {
  sql: string;
  parameters: Record<string, string | number | boolean>;
} {
  const parameters: Record<string, string | number | boolean> = {};
  const column = (name: PropertyColumn) =>
    query.qualified ? `e.${name}` : name;
  const operand = (value: Operand): string => {
    if (value.kind === 'column') return column(value.column);

    if (value.kind === 'since') return 'self.since';

    if (!value.parameter) return value.literal;

    const name = `p${Object.keys(parameters).length}`;

    parameters[name] =
      typeof value.value === 'bigint' ? String(value.value) : value.value;

    return `$${name}`;
  };
  const predicate = (value: Predicate): string => {
    if (value.kind === 'compare')
      return `(${operand(value.left)} ${value.op} ${operand(value.right)})`;

    if (value.kind === 'null')
      return `(${column(value.column)} IS ${value.not ? 'NOT ' : ''}NULL)`;

    if (value.kind === 'not') return `(NOT ${predicate(value.arg)})`;

    return `(${value.args.map(predicate).join(value.op === 'and' ? ' AND ' : ' OR ')})`;
  };
  const argument =
    query.argument === '*'
      ? '*'
      : `${query.distinct ? 'DISTINCT ' : ''}${column(query.argument)}`;
  const where = query.predicate ? ` WHERE ${predicate(query.predicate)}` : '';

  return {
    sql: `SELECT ${query.aggregate.toUpperCase()}(${argument}) FROM self.events e${where}`,
    parameters,
  };
}
