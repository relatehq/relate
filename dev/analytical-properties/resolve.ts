import { inputValue } from './values.js';
import { invalid } from './contracts.js';
import type {
  Association,
  Expression,
  LogicalType,
  Operand,
  Predicate,
  ResolvedExpression,
  Scalar,
  SqlQuery,
} from './contracts.js';

/** PG folds unquoted identifiers. Declarations must not collide after folding. */
function lookup<T>(entries: Record<string, T>, name: string): [string, T] {
  const matches = Object.entries(entries).filter(
    ([key]) => key === name || key.toLowerCase() === name,
  );

  if (matches.length !== 1) invalid('unknown-property');

  return matches[0]!;
}

export function resolveExpression(
  query: SqlQuery,
  expression: Expression,
  association: Association,
): ResolvedExpression {
  if (query.association !== association.name) invalid('unknown-property');

  for (const entries of [association.columns, association.properties]) {
    const keys = Object.keys(entries).map((key) => key.toLowerCase());

    if (new Set(keys).size !== keys.length) invalid('identifier-collision');
  }

  const parameters = expression.parameters ?? {};

  if (
    Object.keys(parameters).length > 16 ||
    Object.values(parameters).some(
      (v) => new TextEncoder().encode(JSON.stringify(v)).length > 1024,
    )
  )
    invalid('parameter-limit');

  const parameterTypes: Record<string, LogicalType> = Object.create(null);
  const values: Record<string, Scalar> = Object.create(null);
  const dependencies = new Set<string>(Object.values(association.on));
  let forbidden = false;

  function reference(value: Operand): LogicalType | undefined {
    if (value.kind !== 'column' && value.kind !== 'self') return undefined;

    const [name, definition] = lookup(
      value.kind === 'column' ? association.columns : association.properties,
      value.name,
    );

    value.name = name;

    if (!definition.readable) forbidden = true;

    if (value.kind === 'self') dependencies.add(name);

    return definition.type;
  }

  function assign(value: Operand, type: LogicalType): void {
    const actual = reference(value);

    if (actual && actual !== type) invalid('type-mismatch');

    if (value.kind === 'parameter') {
      if (parameterTypes[value.name] && parameterTypes[value.name] !== type)
        invalid('parameter-type-conflict');

      parameterTypes[value.name] = type;
      values[value.name] = inputValue(
        Object.hasOwn(parameters, value.name)
          ? parameters[value.name]
          : undefined,
        type,
      );
    }

    if (value.kind === 'literal') {
      value.value = inputValue(value.value, type);
      value.type = type;
    }
  }

  function predicate(value: Predicate): void {
    if (value.kind === 'boolean') {
      value.args.forEach(predicate);

      return;
    }

    if (value.kind === 'null') {
      if (!reference(value.value)) invalid('not-supported');

      return;
    }

    const left = reference(value.left),
      right = reference(value.right);
    const type =
      left ??
      right ??
      (value.left.kind === 'literal' && typeof value.left.value === 'number'
        ? 'float64'
        : undefined);

    if (!type) invalid('ambiguous-type');

    assign(value.left, type);
    assign(value.right, type);
  }

  const input = query.argument === '*' ? undefined : reference(query.argument);

  if (query.predicate) predicate(query.predicate);

  for (const [column, property] of Object.entries(association.on)) {
    const c = association.columns[column],
      p = association.properties[property];

    if (!c || !p || c.type !== p.type || c.type === 'float64')
      invalid('correlation-type');

    if (!c.readable) forbidden = true;
  }

  if (!Object.keys(association.on).length) invalid('missing-correlation');

  if (
    ['sum', 'avg'].includes(query.aggregate) &&
    !['int64', 'float64'].includes(input!)
  )
    invalid('not-supported');

  const type =
    query.aggregate === 'count'
      ? 'int64'
      : query.aggregate === 'avg'
        ? 'float64'
        : input!;

  return {
    query,
    values,
    parameterTypes,
    type,
    nullable: query.aggregate !== 'count',
    dependencies: [...dependencies],
    forbidden,
  };
}
