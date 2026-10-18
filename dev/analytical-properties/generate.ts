import { inputValue } from './values.js';
import type {
  Association,
  Candidate,
  LogicalType,
  Operand,
  Predicate,
  ResolvedExpression,
  Scalar,
  Statement,
} from './contracts.js';

export function quote(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}

/** Caller SQL is discarded. Every identifier below comes from resolved bindings. */
export function generate(
  dialect: 'postgres' | 'sqlite',
  association: Association,
  candidates: Candidate[],
  expressions: ResolvedExpression[],
): Statement {
  const values: Scalar[] = [];
  const properties = [...new Set(expressions.flatMap((e) => e.dependencies))];
  const types = {
    string: 'text',
    timestamp: 'timestamptz',
    int64: 'bigint',
    float64: 'double precision',
  };

  function bind(value: Scalar, type: LogicalType): string {
    values.push(inputValue(value, type));

    return dialect === 'postgres'
      ? `$${values.length}::${types[type]}`
      : type === 'int64'
        ? 'CAST(? AS INTEGER)'
        : '?';
  }

  const keyRows = candidates.map(
    (candidate, slot) =>
      `(${slot}, ${properties.map((property) => bind(candidate.properties[property]!, association.properties[property]!.type)).join(', ')})`,
  );

  function operand(value: Operand, expression: ResolvedExpression): string {
    if (value.kind === 'column')
      return `e.${quote(association.columns[value.name]!.physical)}`;

    if (value.kind === 'self')
      return `k.${quote(`p${properties.indexOf(value.name)}`)}`;

    if (value.kind === 'parameter')
      return bind(
        expression.values[value.name]!,
        expression.parameterTypes[value.name]!,
      );

    return bind(value.value, value.type!);
  }

  function predicate(value: Predicate, expression: ResolvedExpression): string {
    if (value.kind === 'compare')
      return `(${operand(value.left, expression)} ${value.op} ${operand(value.right, expression)})`;

    if (value.kind === 'null')
      return `(${operand(value.value, expression)} IS ${value.not ? 'NOT ' : ''}NULL)`;

    const args = value.args.map((arg) => predicate(arg, expression));

    return value.op === 'not'
      ? `(NOT ${args[0]})`
      : `(${args.join(value.op === 'and' ? ' AND ' : ' OR ')})`;
  }

  const aggregates = expressions.map((expression, index) => {
    const q = expression.query;
    const aggregate = `${q.aggregate.toUpperCase()}(${q.distinct ? 'DISTINCT ' : ''}${q.argument === '*' ? '*' : operand(q.argument, expression)})${q.predicate ? ` FILTER (WHERE ${predicate(q.predicate, expression)})` : ''}`;

    return `${dialect === 'postgres' && q.aggregate === 'avg' ? `CAST(${aggregate} AS double precision)` : aggregate} AS v${index}`;
  });
  const correlation = Object.entries(association.on)
    .map(
      ([column, property]) =>
        `e.${quote(association.columns[column]!.physical)} = k.${quote(`p${properties.indexOf(property)}`)}`,
    )
    .join(' AND ');

  // Group by slot, not just the correlation key: self values may differ for two
  // objects sharing a key. Inner join excludes phantom rows from COUNT(*).
  return {
    text: `WITH keys(slot, ${properties.map((_, i) => quote(`p${i}`)).join(', ')}) AS (VALUES ${keyRows.join(', ')}),
agg AS (SELECT k.slot, ${aggregates.join(', ')} FROM keys k JOIN ${quote(association.table)} e ON ${correlation} GROUP BY k.slot)
SELECT k.slot, ${expressions.map((e, i) => `${e.query.aggregate === 'count' ? `COALESCE(a.v${i}, 0)` : `a.v${i}`} AS v${i}`).join(', ')} FROM keys k LEFT JOIN agg a ON a.slot = k.slot ORDER BY k.slot`,
    values,
  };
}
