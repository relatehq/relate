import {
  accepts,
  acceptsInstant,
  canonicalJson,
  isPlainObject,
} from 'relate/model';
import type { ScalarSchema } from 'relate/model';
import type { FilterScalar, RequestIssue } from '@relate/protocol';
import { invalidValue, schemaText } from './options.js';

interface FilterProperty {
  readonly id: string;
  readonly name: string;
  readonly schema: ScalarSchema;
  readonly references?: string | undefined;
}

type Condition =
  | { readonly operator: 'eq'; readonly value: FilterScalar }
  | { readonly operator: 'in'; readonly value: readonly FilterScalar[] }
  | { readonly operator: 'gt' | 'gte' | 'lt' | 'lte'; readonly value: number };

/** Validated, normalized once per request; values use instant milliseconds for timestamps. */
export interface Predicate {
  readonly propertyId: string;
  readonly name: string;
  readonly timestamp: boolean;
  readonly conditions: readonly Condition[];
}

/** Discovery and validation use the same operator vocabulary. */
export function filterOperators(schema: ScalarSchema): readonly string[] {
  return schema.type === 'number' || schema.format === 'timestamp'
    ? ['eq', 'in', 'gt', 'gte', 'lt', 'lte']
    : ['eq', 'in'];
}

export function compilePredicate(
  property: FilterProperty,
  input: unknown,
  issues: RequestIssue[],
): Predicate {
  const path = ['where', property.name];
  const operators = filterOperators(property.schema);
  const timestamp = property.schema.format === 'timestamp';
  const normalize = (value: FilterScalar): FilterScalar =>
    timestamp && typeof value === 'string' ? Date.parse(value) : value;
  const operatorObject = isPlainObject(input);
  const entries: [string, unknown][] = operatorObject
    ? Object.entries(input)
    : [['eq', input]];
  const conditions: Condition[] = [];

  // A bare array is the likeliest carry-over from plain equality filters.
  if (Array.isArray(input)) {
    issues.push({
      path,
      problem: 'invalid-value',
      message:
        'an array is not a filter value; use { in: [...] } to match any of several values.',
    });

    return {
      propertyId: property.id,
      name: property.name,
      timestamp,
      conditions,
    };
  }

  if (entries.length > 6) {
    issues.push(invalidValue(path, 'at most six scalar operators', input));

    return {
      propertyId: property.id,
      name: property.name,
      timestamp,
      conditions,
    };
  }

  if (!entries.length)
    issues.push(
      invalidValue(path, 'a scalar or a nonempty operator object', input),
    );

  for (const [operator, value] of entries) {
    const location = operatorObject ? [...path, operator] : path;

    if (!operators.includes(operator)) {
      issues.push({
        path: location,
        problem: 'invalid-value',
        message: 'unsupported filter operator for this property.',
        accepted: operators,
      });
      continue;
    }

    if (operator === 'in' && (!Array.isArray(value) || value.length > 100)) {
      issues.push(
        invalidValue(location, 'an array of at most 100 scalar values', value),
      );
      continue;
    }

    const operands = operator === 'in' ? (value as unknown[]) : [value];
    const normalized: FilterScalar[] = [];
    const range = operator !== 'eq' && operator !== 'in';
    // Value bounds describe stored values, not thresholds: { gt: 0 } is valid on
    // a positive number. Ranges keep only type, finiteness and timestamp format.
    const schema: ScalarSchema = range
      ? {
          type: property.schema.type,
          optional: false,
          nullable: false,
          ...(timestamp ? { format: 'timestamp' as const } : {}),
        }
      : property.schema;

    for (const [index, operand] of operands.entries()) {
      const operandPath =
        operator === 'in' ? [...location, String(index)] : location;
      const valid =
        operand !== undefined &&
        (timestamp && typeof operand === 'string'
          ? acceptsInstant(operand)
          : accepts(schema, operand));

      if (!valid)
        issues.push(
          invalidValue(
            operandPath,
            schemaText(schema, property.references),
            operand,
          ),
        );
      else normalized.push(normalize(operand as FilterScalar));
    }

    if (normalized.length !== operands.length) continue;

    if (operator === 'in')
      conditions.push({
        operator,
        value: [...new Set(normalized)].sort((a, b) => {
          const left = canonicalJson(a),
            right = canonicalJson(b);

          return left < right ? -1 : left > right ? 1 : 0;
        }),
      });
    else if (operator === 'eq')
      conditions.push({ operator, value: normalized[0]! });
    else
      conditions.push({
        operator: operator as 'gt' | 'gte' | 'lt' | 'lte',
        value: normalized[0] as number,
      });
  }

  conditions.sort((a, b) =>
    a.operator < b.operator ? -1 : a.operator > b.operator ? 1 : 0,
  );

  return {
    propertyId: property.id,
    name: property.name,
    timestamp,
    conditions,
  };
}

/** Evidence usability is checked by the caller before evaluating any predicate. */
export function matchesPredicate(
  predicate: Predicate,
  value: FilterScalar,
): boolean {
  const actual =
    predicate.timestamp && typeof value === 'string'
      ? Date.parse(value)
      : value;

  return predicate.conditions.every((condition) => {
    switch (condition.operator) {
      case 'eq':
        return actual === condition.value;
      case 'in':
        return condition.value.includes(actual);
      case 'gt':
        return typeof actual === 'number' && actual > condition.value;
      case 'gte':
        return typeof actual === 'number' && actual >= condition.value;
      case 'lt':
        return typeof actual === 'number' && actual < condition.value;
      case 'lte':
        return typeof actual === 'number' && actual <= condition.value;
    }
  });
}
