import {
  accepts,
  acceptsInstant,
  canonicalJson,
  isPlainObject,
} from 'relate/model';
import type { ScalarSchema } from 'relate/model';
import { ReadError } from '@relate/protocol';
import type {
  FieldEvidence,
  FilterScalar,
  FullReadResult,
  ReadRequest,
  RequestIssue,
} from '@relate/protocol';
import { invalidValue, schemaText } from './options.js';
import { project } from './project.js';

type Available = Extract<FullReadResult, { status: 'ok' }>;

/** A property this reader may filter on; filterable means discoverable. */
export interface FilterProperty {
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

/**
 * Compile a where object against the reader's filterable properties. Names
 * outside that set share one answer, so an error never confirms that a hidden
 * field exists. Predicates are ordered by property ID for cursor binding.
 */
export function compileWhere(
  objectName: string,
  properties: () => readonly FilterProperty[],
  where: unknown,
  issues: RequestIssue[],
): Predicate[] {
  const predicates: Predicate[] = [];

  // Option validation reports a malformed or oversized where object.
  if (!isPlainObject(where) || Object.keys(where).length > 100)
    return predicates;

  const entries = Object.entries(where);
  const filterable = entries.length ? properties() : [];

  for (const [name, value] of entries) {
    const property = filterable.find((p) => p.name === name);

    if (!property)
      issues.push({
        path: ['where', name],
        problem: 'unknown-property',
        message: `not a filterable property of ${objectName} for this reader.`,
        accepted: filterable.map((p) => p.name),
      });
    else predicates.push(compilePredicate(property, value, issues));
  }

  return predicates.sort((a, b) =>
    a.propertyId < b.propertyId ? -1 : a.propertyId > b.propertyId ? 1 : 0,
  );
}

/**
 * Evaluate predicates against one read result under the caller's freshness
 * rules. Filter evidence must be available or known absent; `matches` throws
 * `incomplete` otherwise, so a missing value never counts as a non-match.
 */
export function predicateMatcher(
  predicates: readonly Predicate[],
  request: ReadRequest,
  clock: () => number,
) {
  const names = predicates.map((predicate) => predicate.name);
  const evidence = (id: string, result: Available, at: number) =>
    project(id, result, names, { ...request, requireComplete: false }, at);
  const usable = (record: {
    meta: { fields: Record<string, FieldEvidence> };
  }) =>
    Object.values(record.meta.fields).every(
      ({ status }) => status === 'available' || status === 'absent',
    );
  const matches = (id: string, result: Available, at: number): boolean => {
    const record = evidence(id, result, at);

    if (!usable(record)) throw new ReadError('incomplete');

    return predicates.every(
      (predicate) =>
        Object.hasOwn(record.data, predicate.name) &&
        matchesPredicate(
          predicate,
          record.data[predicate.name] as FilterScalar,
        ),
    );
  };

  return {
    /** Property names the filter reads; callers add them to private selections. */
    names,
    matches,
    /**
     * Time may advance between matching and emitting. Re-evaluate under the
     * caller's freshness rules; evidence that expired after matching is
     * refreshed for this member only. `reread` returns undefined when the
     * member is no longer readable. Returns the emission time, or undefined to
     * withhold the member.
     */
    async confirm(
      item: { readonly id: string; result: Available; readonly at: number },
      reread: () => Promise<Available | undefined>,
    ): Promise<number | undefined> {
      let at = clock();

      if (at === item.at) return at;

      if (!usable(evidence(item.id, item.result, at))) {
        const result = await reread();

        if (!result) return undefined;

        item.result = result;
        at = clock();
      }

      return matches(item.id, item.result, at) ? at : undefined;
    },
  };
}
