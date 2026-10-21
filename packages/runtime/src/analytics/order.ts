import type { OrderEntry } from '@relate/protocol';
import { parseAnalyticalValue, encodeAnalyticalValue } from 'relate/analytics';
import type { AnalyticalScalar, ResultType } from 'relate/analytics';
import type { ComputedField } from './execution-types.js';
import { AnalyticalPreparationError } from './types.js';

export interface ComputedPosition {
  readonly id: string;
  readonly values: readonly AnalyticalScalar[];
}

type Fields = Readonly<Record<string, ComputedField>>;

const compare = (
  left: string | number | boolean | bigint,
  right: string | number | boolean | bigint,
) => (left < right ? -1 : left > right ? 1 : 0);

export function computedFilterOperators(type: ResultType): readonly string[] {
  return ['int32', 'int64', 'float64', 'timestamp'].includes(type.type)
    ? ['eq', 'in', 'gt', 'gte', 'lt', 'lte']
    : ['eq', 'in'];
}

/** Typed comparisons only; int64 never passes through Number and null never matches. */
export function prepareComputedOrder(input: {
  readonly where: Readonly<Record<string, unknown>>;
  readonly orderBy: unknown;
  readonly types: Readonly<Record<string, ResultType>>;
}) {
  const fail = (path: readonly string[], message: string): never => {
    throw new AnalyticalPreparationError([
      { path, problem: 'invalid-value', message },
    ]);
  };
  const typeFor = (name: string, path: readonly string[]) => {
    if (!Object.hasOwn(input.types, name))
      fail(
        path,
        'Expected a computed alias or declared computed property. Ordinary property ordering is not supported.',
      );

    return input.types[name]!;
  };
  const valueFor = (
    value: unknown,
    type: ResultType,
    path: readonly string[],
  ) => {
    if (value === null) return null;

    if (type.type === 'int64' && typeof value !== 'string')
      return fail(path, 'Expected a canonical int64 decimal string.');

    try {
      const parsed = parseAnalyticalValue(value, type).value;

      if (type.type === 'int64' && String(parsed) !== value)
        return fail(path, 'Expected a canonical int64 decimal string.');

      return parsed;
    } catch {
      return fail(path, `Expected a ${type.type} comparison value.`);
    }
  };
  const scalarCompare = (
    a: Exclude<AnalyticalScalar, null>,
    b: Exclude<AnalyticalScalar, null> | bigint,
    type: ResultType,
  ) =>
    type.type === 'int64'
      ? compare(BigInt(a as string), BigInt(b as string))
      : compare(a, b);
  const predicates: ((fields: Fields) => boolean)[] = [];

  for (const [name, operand] of Object.entries(input.where)) {
    const path = ['where', name];
    const type = typeFor(name, path);
    const operators =
      operand !== null && typeof operand === 'object' && !Array.isArray(operand)
        ? Object.entries(operand)
        : [['eq', operand] as const];

    if (!operators.length) fail(path, 'Expected a comparison operator.');

    for (const [operator, raw] of operators) {
      const at = [...path, operator];

      if (!['eq', 'in', 'gt', 'gte', 'lt', 'lte'].includes(operator))
        fail(at, 'Unknown computed comparison operator.');

      const range = !['eq', 'in'].includes(operator);

      if (
        range &&
        !['int32', 'int64', 'float64', 'timestamp'].includes(type.type)
      )
        fail(at, 'Range comparisons require a number or timestamp.');

      if (range && raw === null) fail(at, 'Range bounds cannot be null.');

      if (operator === 'in' && (!Array.isArray(raw) || raw.length > 100))
        fail(at, 'in requires at most 100 scalar values.');

      const values = (operator === 'in' ? (raw as unknown[]) : [raw]).map(
        (value) => valueFor(value, type, at),
      );

      predicates.push((fields) => {
        const field = fields[name];

        if (field?.status !== 'available' || field.value === null) return false;

        return values.some((value) => {
          if (value === null) return false;

          const difference = scalarCompare(field.value!, value, type);

          switch (operator) {
            case 'eq':
            case 'in':
              return difference === 0;
            case 'gt':
              return difference > 0;
            case 'gte':
              return difference >= 0;
            case 'lt':
              return difference < 0;
            case 'lte':
              return difference <= 0;
            default:
              return false;
          }
        });
      });
    }
  }

  const order: OrderEntry[] = [];
  const supplied = input.orderBy ?? [];

  if (!Array.isArray(supplied) || supplied.length > 8)
    fail(['orderBy'], 'orderBy requires at most eight computed fields.');

  for (const [index, entry] of (supplied as unknown[]).entries()) {
    const path = ['orderBy', String(index)];

    if (
      !entry ||
      typeof entry !== 'object' ||
      Array.isArray(entry) ||
      Object.keys(entry).some((key) => !['field', 'direction'].includes(key))
    )
      fail(path, 'Expected { field, direction }.');

    const { field, direction } = entry as Record<string, unknown>;

    if (
      typeof field !== 'string' ||
      !['asc', 'desc'].includes(direction as string)
    )
      fail(path, 'Expected a computed field and asc or desc direction.');

    typeFor(field as string, [...path, 'field']);

    if (order.some((item) => item.field === field))
      fail(path, 'Duplicate order field.');

    order.push({
      field: field as string,
      direction: direction as 'asc' | 'desc',
    });
  }

  return {
    required: [
      ...new Set([
        ...Object.keys(input.where),
        ...order.map((entry) => entry.field),
      ]),
    ],
    matches: (fields: Fields) =>
      predicates.every((predicate) => predicate(fields)),
    position(id: string, fields: Fields): ComputedPosition {
      return {
        id,
        values: order.map(({ field }) => {
          const value = fields[field];

          if (value?.status !== 'available')
            throw new Error('Missing required ordering value');

          return value.value;
        }),
      };
    },
    compare(left: ComputedPosition, right: ComputedPosition) {
      for (const [index, entry] of order.entries()) {
        const a = left.values[index]!,
          b = right.values[index]!;
        const difference =
          a === null
            ? b === null
              ? 0
              : 1
            : b === null
              ? -1
              : scalarCompare(a, b, input.types[entry.field]!) *
                (entry.direction === 'asc' ? 1 : -1);

        if (difference) return difference;
      }

      return compare(left.id, right.id);
    },
    /** Called only after authenticated cursor decoding; still validate its position shape. */
    parsePosition(text: string): ComputedPosition {
      const value = JSON.parse(text) as ComputedPosition;

      if (
        !value ||
        typeof value.id !== 'string' ||
        !value.id ||
        !Array.isArray(value.values) ||
        value.values.length !== order.length ||
        Object.keys(value).some((key) => !['id', 'values'].includes(key))
      )
        throw new Error('Invalid computed position');

      value.values.forEach((scalar, index) => {
        if (
          encodeAnalyticalValue(scalar, input.types[order[index]!.field]!) !==
          scalar
        )
          throw new Error('Noncanonical computed position');
      });

      return value;
    },
  };
}
