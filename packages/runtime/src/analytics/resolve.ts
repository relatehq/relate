import { parseAnalyticalValue } from 'relate/analytics';
import type {
  LogicalType,
  ResultType,
  Name,
  Operand,
  Predicate,
  RelateSqlQuery,
  LiteralOperand,
} from 'relate/analytics';
import type {
  ResolvedOperand,
  ResolvedPredicate,
  TypedValue,
} from 'relate/connectors';
import { AnalyticalPreparationError } from './types.js';
import type {
  ActorAssociations,
  AnalyticalProperty,
  AnalyticalColumn,
  ResolvedExpression,
  PreparationIssue,
} from './types.js';

function fail(
  message: string,
  at?: Name['at'],
  problem: PreparationIssue['problem'] = 'invalid-value',
): never {
  throw new AnalyticalPreparationError([
    { problem, message, ...(at ? { at } : {}) },
  ]);
}

function logical(type: LogicalType): LogicalType {
  return type.type === 'timestamp'
    ? { type: 'timestamp', precision: type.precision }
    : { type: type.type };
}

function same(left: LogicalType, right: LogicalType): boolean {
  return (
    left.type === right.type &&
    (left.type !== 'timestamp' ||
      (right.type === 'timestamp' && left.precision === right.precision))
  );
}

function compatible(left: LogicalType, right: LogicalType): boolean {
  return left.type === right.type;
}

function lookup<T extends { name: string }>(
  entries: readonly T[],
  name: Name,
): T {
  const matches = entries.filter((entry) =>
    name.quoted
      ? entry.name === name.name
      : entry.name.toLowerCase() === name.name.toLowerCase(),
  );

  if (matches.length !== 1)
    fail('Unknown analytical name.', name.at, 'unknown-property');

  return matches[0]!;
}

function intrinsic(value: Operand): LogicalType | undefined {
  if (value.kind !== 'literal' || value.literal === 'null') return undefined;

  if (value.literal === 'number')
    return { type: /^-?\d+$/.test(value.value) ? 'int64' : 'float64' };

  return { type: value.literal };
}

/** Interpret integer-context SQL numerics without rounding through a JS number. */
function integerLiteral(value: {
  readonly value: string;
  readonly at: Name['at'];
}): string {
  const match = /^([+-]?)([0-9]*)(?:\.([0-9]*))?(?:[eE]([+-]?[0-9]+))?$/.exec(
    value.value,
  );

  if (!match || !(match[2] || match[3]))
    fail('Literal does not match its inferred type.', value.at);

  let digits = `${match[2]}${match[3] ?? ''}`.replace(/^0+/, '');
  let shift = Number(match[4] ?? 0) - (match[3]?.length ?? 0);

  if (!digits) return '0';

  if (!Number.isSafeInteger(shift))
    fail('Literal does not match its inferred type.', value.at);

  if (shift < 0) {
    if (-shift >= digits.length || !/^0*$/.test(digits.slice(shift)))
      fail('Literal does not match its inferred type.', value.at);

    digits = digits.slice(0, shift);
    shift = 0;
  }

  if (digits.length + shift > 20)
    fail('Literal does not match its inferred type.', value.at);

  return `${match[1] === '-' ? '-' : ''}${digits}${'0'.repeat(shift)}`;
}

function literalValue(value: LiteralOperand, type: LogicalType): TypedValue {
  if (value.literal === 'null')
    fail('NULL literals are allowed only in IS NULL expressions.', value.at);

  let input: unknown = value.value;

  if (value.literal === 'number') {
    if (!['int32', 'int64', 'float64'].includes(type.type))
      fail('Numeric literal has an incompatible type.', value.at);

    input =
      type.type === 'int64'
        ? integerLiteral(value)
        : type.type === 'int32'
          ? Number(integerLiteral(value))
          : Number(value.value);
  } else if (value.literal === 'string') {
    if (type.type === 'int32' && /^-?(0|[1-9][0-9]*)$/.test(value.value))
      input = Number(value.value);

    if (
      type.type === 'float64' &&
      /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(value.value)
    )
      input = Number(value.value);

    if (type.type === 'boolean' && /^(true|false)$/i.test(value.value))
      input = value.value.toLowerCase() === 'true';
  }

  try {
    return parseAnalyticalValue(input, type);
  } catch {
    return fail('Literal does not match its inferred type.', value.at);
  }
}

/** Resolve logical names and scalar types without reading any object or resource. */
export function resolveExpression(
  query: RelateSqlQuery,
  scope: ActorAssociations,
  parameters: Readonly<Record<string, unknown>> = {},
  options: {
    readonly declared?: boolean;
    readonly maxParameters?: number;
    readonly maxParameterBytes?: number;
  } = {},
): ResolvedExpression {
  const association = lookup(scope.associations, query.association);
  const maxParameters = options.maxParameters ?? 16;
  const maxParameterBytes = options.maxParameterBytes ?? 1024;

  if (
    !parameters ||
    typeof parameters !== 'object' ||
    Array.isArray(parameters)
  )
    fail('Parameters must be a named JSON object.');

  if (Object.keys(parameters).length > maxParameters)
    fail('The expression exceeds the parameter limit.');

  for (const value of Object.values(parameters)) {
    let json: string | undefined;

    try {
      json = JSON.stringify(value);
    } catch {
      fail('Parameters must contain JSON scalar values.');
    }

    if (
      json === undefined ||
      value === null ||
      !['string', 'number', 'boolean'].includes(typeof value) ||
      (typeof value === 'number' && !Number.isFinite(value))
    )
      fail('Parameters must contain non-null JSON scalar values.');

    if (new TextEncoder().encode(json).length > maxParameterBytes)
      fail('A parameter exceeds the value size limit.');
  }

  const dependencies: {
    id: string;
    type: LogicalType;
    correlation: boolean;
  }[] = [];
  const columns = new Set<string>();
  const parameterTypes = new Map<string, LogicalType>();
  const references = new Map<Operand, AnalyticalProperty | AnalyticalColumn>();
  let forbidden = false,
    correlationForbidden = false;
  const dependency = (
    property: AnalyticalProperty,
    correlation = false,
  ): number => {
    if (property.calculated)
      fail(
        'Calculated properties cannot be SQL dependencies.',
        undefined,
        'not-supported',
      );

    if (!property.schema)
      fail(
        'Property has no supported analytical scalar type.',
        undefined,
        'not-supported',
      );

    let index = dependencies.findIndex((entry) => entry.id === property.id);

    if (index === -1) {
      index = dependencies.length;
      dependencies.push({
        id: property.id,
        type: logical(property.schema),
        correlation,
      });
    }

    return index;
  };

  for (const pair of association.on) {
    const column = association.columns.find(
      (entry) => entry.id === pair.columnDefinitionId,
    );
    const property = scope.properties.find(
      (entry) => entry.id === pair.propertyDefinitionId,
    );

    if (
      !column ||
      !property ||
      !property.schema ||
      property.calculated ||
      property.schema.type === 'float64' ||
      !compatible(column.schema, property.schema)
    )
      fail('Invalid declared correlation.', undefined, 'not-supported');

    dependency(property, true);
    columns.add(column.id);

    if (!column.readable) forbidden = true;

    if (!property.readable) correlationForbidden = true;
  }

  if (!association.on.length)
    fail(
      'An analytical association requires correlation.',
      undefined,
      'not-supported',
    );

  const reference = (operand: Operand): LogicalType | undefined => {
    if (operand.kind !== 'column' && operand.kind !== 'self') return undefined;

    let entry = references.get(operand);

    if (!entry) {
      entry =
        operand.kind === 'column'
          ? lookup(association.columns, operand)
          : lookup(scope.properties, operand);

      if ('calculated' in entry && entry.calculated)
        fail(
          'Calculated properties cannot be SQL dependencies.',
          operand.at,
          'not-supported',
        );

      if (!entry.schema)
        fail(
          'Property has no supported analytical scalar type.',
          operand.at,
          'not-supported',
        );

      references.set(operand, entry);

      if (operand.kind === 'self') {
        const index = dependency(entry as AnalyticalProperty);

        if (!entry.readable && !dependencies[index]!.correlation)
          forbidden = true;
      } else {
        columns.add(entry.id);

        if (!entry.readable) forbidden = true;
      }
    }

    return logical(entry.schema!);
  };
  const operands: Operand[] = [];
  const comparisons: Extract<Predicate, { kind: 'compare' }>[] = [];
  const visit = (predicate: Predicate): void => {
    if (predicate.kind === 'boolean') predicate.args.forEach(visit);
    else if (predicate.kind === 'compare') {
      comparisons.push(predicate);
      operands.push(predicate.left, predicate.right);
    } else operands.push(predicate.value);
  };

  if (query.argument !== '*') operands.push(query.argument);

  if (query.predicate) visit(query.predicate);

  for (const operand of operands) {
    reference(operand);

    if (operand.kind === 'parameter' && options.declared)
      fail(
        'Declared calculations cannot use named parameters.',
        operand.at,
        'not-supported',
      );
  }

  const known = (operand: Operand): LogicalType | undefined =>
    reference(operand) ??
    (operand.kind === 'parameter'
      ? parameterTypes.get(operand.name)
      : undefined);
  const assign = (operand: Operand, type: LogicalType) => {
    const actual = known(operand);

    if (actual && !compatible(actual, type))
      fail('Operands have incompatible logical types.', operand.at);

    if (operand.kind !== 'parameter') return;

    const previous = parameterTypes.get(operand.name);

    if (previous && !same(previous, type))
      fail('A parameter is used with conflicting types.', operand.at);

    parameterTypes.set(operand.name, logical(type));
  };
  const comparisonType = (
    left: Operand,
    right: Operand,
  ): LogicalType | undefined => {
    const a = known(left),
      b = known(right);

    if (a && b) {
      if (!compatible(a, b))
        fail('Operands have incompatible logical types.', right.at);

      // References retain their own exact precision. A parameter must have one type.
      return reference(left) ?? reference(right) ?? a;
    }

    if (a || b) return a ?? b;

    const x = intrinsic(left),
      y = intrinsic(right);

    if (
      x &&
      y &&
      x.type !== y.type &&
      [x.type, y.type].every((type) => ['int64', 'float64'].includes(type))
    )
      return { type: 'float64' };

    return x ?? y;
  };

  // A parameter used in an aggregate or IS NULL may be typed by another comparison.
  for (let pass = 0; pass <= operands.length; pass++) {
    const before = parameterTypes.size;

    for (const comparison of comparisons) {
      const type = comparisonType(comparison.left, comparison.right);

      if (type) {
        assign(comparison.left, type);
        assign(comparison.right, type);
      }
    }

    if (before === parameterTypes.size) break;
  }

  const values = new Map<string, TypedValue>();
  const resolve = (
    operand: Operand,
    expected?: LogicalType,
    allowNull = false,
  ): ResolvedOperand => {
    const type = known(operand) ?? expected ?? intrinsic(operand);

    if (operand.kind === 'literal' && operand.literal === 'null') {
      if (!allowNull)
        fail(
          'NULL literals are allowed only in IS NULL expressions.',
          operand.at,
        );

      return { kind: 'value', value: { type: 'string', value: null } };
    }

    if (!type) fail('Cannot infer an analytical operand type.', operand.at);

    if (expected && !compatible(type, expected))
      fail('Operands have incompatible logical types.', operand.at);

    if (operand.kind === 'column')
      return { kind: 'column', column: references.get(operand)!.name, type };

    if (operand.kind === 'self')
      return {
        kind: 'key',
        key: dependency(references.get(operand) as AnalyticalProperty),
        type,
      };

    if (operand.kind === 'literal')
      return { kind: 'value', value: literalValue(operand, expected ?? type) };

    if (!Object.hasOwn(parameters, operand.name))
      fail('Missing named parameter.', operand.at);

    if (!values.has(operand.name)) {
      try {
        values.set(
          operand.name,
          parseAnalyticalValue(parameters[operand.name], type),
        );
      } catch {
        fail('Parameter does not match its inferred type.', operand.at);
      }
    }

    return { kind: 'value', value: values.get(operand.name)! };
  };
  const predicate = (input: Predicate): ResolvedPredicate => {
    if (input.kind === 'boolean')
      return { kind: 'boolean', op: input.op, args: input.args.map(predicate) };

    if (input.kind === 'null')
      return {
        kind: 'null',
        not: input.not,
        value: resolve(input.value, undefined, true),
      };

    const type = comparisonType(input.left, input.right);

    if (!type) fail('Cannot infer comparison types.');

    return {
      kind: 'compare',
      op: input.op,
      left: resolve(input.left, type),
      right: resolve(input.right, type),
    };
  };
  const argument = query.argument === '*' ? '*' : resolve(query.argument);
  const inputType =
    argument === '*'
      ? undefined
      : argument.kind === 'value'
        ? logical(argument.value)
        : argument.type;

  if (
    ['sum', 'avg'].includes(query.aggregate) &&
    (!inputType || !['int32', 'int64', 'float64'].includes(inputType.type))
  )
    fail(
      'This aggregate requires a numeric operand.',
      query.argument === '*' ? undefined : query.argument.at,
      'not-supported',
    );

  const result: ResultType =
    query.aggregate === 'count'
      ? { type: 'int64', nullable: false }
      : query.aggregate === 'avg'
        ? { type: 'float64', nullable: true }
        : query.aggregate === 'sum' && inputType?.type !== 'float64'
          ? { type: 'int64', nullable: true }
          : { ...inputType!, nullable: true };
  const filter = query.predicate ? predicate(query.predicate) : undefined;
  const fallback = query.fallback
    ? literalValue(query.fallback, result)
    : undefined;

  if (Object.keys(parameters).some((name) => !values.has(name)))
    fail('An unused named parameter was supplied.');

  return {
    association,
    dependencies,
    columns: [...columns],
    parameterTypes: Object.fromEntries(parameterTypes),
    parameters: Object.fromEntries(values),
    forbidden,
    correlationForbidden,
    aggregate: {
      aggregate: query.aggregate,
      argument,
      distinct: query.distinct,
      ...(filter ? { predicate: filter } : {}),
      ...(fallback ? { fallback } : {}),
      result: fallback ? { ...result, nullable: false } : result,
    },
  };
}
