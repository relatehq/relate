import type {
  AuthorizedDatasetQuery,
  ResolvedAggregate,
  ResolvedScalarExpression,
  ResolvedOperand,
  ResolvedPredicate,
  ResolvedRowExpression,
} from './query.js';
import { foldScalarExpression, isRowArithmetic } from './scalar.js';

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

  const numeric = (type: string) => {
    if (!['int32', 'int64', 'float64'].includes(type)) invalid();
  };
  const scalar = (value: ResolvedScalarExpression): void =>
    foldScalarExpression(
      value,
      (leaf) => {
        if (typeof leaf !== 'object' || leaf === null) invalid();

        if (leaf.kind === 'aggregate') {
          // Formula leaves are plain numeric aggregates, never nested formulas.
          if ((leaf.value as ResolvedAggregate).aggregate === 'expression')
            invalid();

          numeric(leaf.value.result.type);
          aggregate(leaf.value);
        } else if (leaf.kind === 'operand') {
          if (leaf.value.kind === 'column') invalid();

          operand(leaf.value);
          numeric(
            leaf.value.kind === 'value'
              ? leaf.value.value.type
              : leaf.value.type.type,
          );
        } else invalid();
      },
      (node) => {
        if (
          node.kind === 'binary'
            ? !['+', '-', '*', '/'].includes(node.op)
            : !['nullif', 'coalesce'].includes(node.kind)
        )
          invalid();
      },
    );
  // Node types must be the promotion of their children's types.
  const row = (value: ResolvedRowExpression): 'int64' | 'float64' => {
    if (typeof value !== 'object' || value === null) invalid();

    if (!isRowArithmetic(value)) {
      operand(value);
      const type = value.kind === 'value' ? value.value.type : value.type.type;

      numeric(type);

      return type === 'float64' ? 'float64' : 'int64';
    }

    if (!['+', '-', '*', '/'].includes(value.op)) invalid();

    const left = row(value.left),
      right = row(value.right);
    const type =
      value.op === '/' || left === 'float64' || right === 'float64'
        ? 'float64'
        : 'int64';

    if (value.type?.type !== type) invalid();

    return type;
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

    if (aggregate.argument !== '*') {
      if (isRowArithmetic(aggregate.argument)) {
        if (aggregate.distinct) invalid();

        row(aggregate.argument);
      } else operand(aggregate.argument);
    }

    if (aggregate.predicate) predicate(aggregate.predicate);
  };

  query.aggregates.forEach(aggregate);

  for (const pair of query.correlation) {
    key(pair.key);
    column(pair.column);
  }
}
