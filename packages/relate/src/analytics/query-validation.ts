import type {
  AuthorizedDatasetQuery,
  ResolvedAggregate,
  ResolvedScalarExpression,
  ResolvedOperand,
  ResolvedPredicate,
} from './query.js';

function invalid(): never {
  throw new Error('Invalid authorized analytical query');
}

/**
 * Common logical query invariants for SQL connectors. An empty slot list is
 * allowed for parameter budgeting; executable plans must require at least one.
 * Columns are declared mapping keys, never physical SQL identifiers.
 */
export function validateAuthorizedDatasetQuery(
  query: AuthorizedDatasetQuery,
  columns: readonly string[],
): void {
  const declared = new Set(columns);
  const key = (index: number) => {
    if (!Number.isSafeInteger(index) || index < 0 || !query.keys[index])
      invalid();
  };
  const column = (name: string) => {
    if (!declared.has(name)) invalid();
  };
  const operand = (value: ResolvedOperand): void => {
    if (value.kind === 'column') column(value.column);
    else if (value.kind === 'key') key(value.key);
    else if (value.kind !== 'value') invalid();
  };
  const predicate = (value: ResolvedPredicate): void => {
    if (value.kind === 'compare') {
      if (!['=', '<>', '<', '<=', '>', '>='].includes(value.op)) invalid();

      operand(value.left);
      operand(value.right);
    } else if (value.kind === 'null') operand(value.value);
    else {
      if (
        value.kind !== 'boolean' ||
        !['and', 'or', 'not'].includes(value.op) ||
        !value.args.length ||
        (value.op === 'not' && value.args.length !== 1)
      )
        invalid();

      value.args.forEach(predicate);
    }
  };

  if (
    !query.keys.length ||
    !query.correlation.length ||
    !query.aggregates.length
  )
    invalid();

  for (const slot of query.slots) {
    if (
      slot.values.length !== query.keys.length ||
      slot.valid.length !== query.aggregates.length
    )
      invalid();

    slot.values.forEach((value, index) => {
      const type = query.keys[index]!.type;

      if (
        type.type !== value.type ||
        (type.type === 'timestamp' &&
          value.type === 'timestamp' &&
          type.precision !== value.precision)
      )
        invalid();
    });
  }

  const scalar = (value: ResolvedScalarExpression): void => {
    if (value.kind === 'aggregate') aggregate(value.value);
    else if (value.kind === 'operand') {
      if (value.value.kind === 'column') invalid();

      operand(value.value);
    } else {
      if (
        value.kind === 'binary'
          ? !['+', '-', '*', '/'].includes(value.op)
          : !['nullif', 'coalesce'].includes(value.kind)
      )
        invalid();

      scalar(value.left);
      scalar(value.right);
    }
  };
  const aggregate = (aggregate: ResolvedAggregate): void => {
    if (aggregate.aggregate === 'expression') {
      if (aggregate.result.type !== 'float64') invalid();

      scalar(aggregate.expression);

      return;
    }

    if (
      !['count', 'sum', 'avg', 'min', 'max'].includes(aggregate.aggregate) ||
      (aggregate.distinct && aggregate.aggregate !== 'count') ||
      (aggregate.argument === '*' &&
        (aggregate.aggregate !== 'count' || aggregate.distinct))
    )
      invalid();

    if (aggregate.argument !== '*') operand(aggregate.argument);

    if (aggregate.predicate) predicate(aggregate.predicate);
  };

  query.aggregates.forEach(aggregate);

  for (const pair of query.correlation) {
    key(pair.key);
    column(pair.column);
  }
}
