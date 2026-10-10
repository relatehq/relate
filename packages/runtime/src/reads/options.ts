import { ReadError } from '@relate/protocol';
import type { Json, RequestIssue } from '@relate/protocol';
import { isPlainObject } from 'relate/model';
import type { ScalarSchema } from 'relate/model';

/** The read operations a caller can invoke; options and errors are defined per kind. */
export type ReadOperation = 'get' | 'query' | 'traverse-many' | 'traverse-one';

/** A caller option as discovery presents it. */
export interface OptionDescription {
  readonly name: string;
  readonly type: string;
  readonly default?: Json;
  readonly description: string;
}

interface OptionRule extends OptionDescription {
  readonly operations: readonly ReadOperation[];
  valid(value: unknown): boolean;
}

const every: readonly ReadOperation[] = [
  'get',
  'query',
  'traverse-many',
  'traverse-one',
];
const paged: readonly ReadOperation[] = ['query', 'traverse-many'];
const unsafe = ['__proto__', 'constructor', 'prototype'];

/**
 * The single source for read options: validation, discovery and error messages
 * all read this table, so a documented option is exactly an accepted option.
 */
const rules: readonly OptionRule[] = [
  {
    name: 'where',
    type: '{ [property]: scalar | { eq?, in?, gt?, gte?, lt?, lte? } } (at most 100 properties)',
    description:
      "Scalar equality or operator objects on property names of the returned object, combined with AND (a traversal also requires the relationship). eq/in work on every scalar; gt/gte/lt/lte require numbers or timestamps. Operator entries also combine with AND. in accepts at most 100 values; [] matches nothing. Range operands are not limited by a number property's value bounds. Timestamp operands accept any timezone-qualified ISO instant with at most millisecond precision (for example 2026-10-01T00:00:00Z); comparison uses the instant. Use in, not a bare array, to match several values. null matches only explicit null; absence does not match. A reference property matches a Relate object ID (a record's `id`, or another record's reference value), not a source-system ID; an ID that is not in the graph matches nothing.",
    operations: paged,
    valid: (value) => isPlainObject(value) && Object.keys(value).length <= 100,
  },
  {
    name: 'select',
    type: 'string[] (at most 100)',
    description:
      'Property names to return. Defaults to every property this reader may read; [] returns no property values.',
    operations: every,
    valid: (value) =>
      Array.isArray(value) &&
      value.length <= 100 &&
      value.every((p) => typeof p === 'string' && !unsafe.includes(p)),
  },
  {
    name: 'limit',
    type: 'integer 1–100',
    default: 25,
    description:
      'Maximum records per page. A page can hold fewer, even none, before the collection is exhausted.',
    operations: paged,
    valid: (value) =>
      Number.isInteger(value) &&
      (value as number) >= 1 &&
      (value as number) <= 100,
  },
  {
    name: 'cursor',
    type: 'string',
    description:
      'page.meta.continuationCursor from the previous page of the same call with the same options (evidence may change). There is no offset or page-number paging.',
    operations: paged,
    valid: (value) => typeof value === 'string' && value.length > 0,
  },
  {
    name: 'evidence',
    type: "'compact' | 'full'",
    default: 'compact',
    description:
      "'full' returns evidence for every selected field in meta.fields; 'compact' lists only exceptional fields.",
    operations: every,
    valid: (value) => value === 'compact' || value === 'full',
  },
  {
    name: 'stale',
    type: "'allow' | 'omit'",
    default: 'allow',
    description:
      "'omit' withholds stale values and reports them as unavailable.",
    operations: every,
    valid: (value) => value === 'allow' || value === 'omit',
  },
  {
    name: 'maxAgeMs',
    type: 'number ≥ 0',
    default: 60_000,
    description:
      'Oldest acceptable observation age before a refresh is attempted.',
    operations: every,
    valid: (value) =>
      typeof value === 'number' && Number.isFinite(value) && value >= 0,
  },
  {
    name: 'refresh',
    type: 'boolean',
    default: false,
    description: 'true requests a refresh even within maxAgeMs.',
    operations: every,
    valid: (value) => typeof value === 'boolean',
  },
  {
    name: 'requireComplete',
    type: 'boolean',
    default: false,
    description:
      "true throws ReadError('incomplete') when a selected field is forbidden or unavailable.",
    operations: every,
    valid: (value) => typeof value === 'boolean',
  },
  {
    name: 'timeoutMs',
    type: 'number > 0 and ≤ 10000',
    default: 3_000,
    description: 'Source-operation timeout.',
    operations: every,
    valid: (value) =>
      typeof value === 'number' &&
      Number.isFinite(value) &&
      value > 0 &&
      value <= 10_000,
  },
];

/** Options accepted by one operation kind, or every read option, in discovery order. */
export function optionDescriptions(
  operation?: ReadOperation,
): OptionDescription[] {
  return rules
    .filter((rule) => !operation || rule.operations.includes(operation))
    .map(({ operations: _operations, valid: _valid, ...description }) => ({
      ...description,
    }));
}

const optionNames = (operation: ReadOperation) =>
  optionDescriptions(operation).map((option) => option.name);

const aliases: readonly {
  names: readonly string[];
  /** The generic option the caller probably meant, when there is one. */
  option?: string;
  hint: string;
}[] = [
  {
    names: [
      'pageSize',
      'page_size',
      'perPage',
      'per_page',
      'size',
      'max',
      'maxResults',
      'max_results',
      'first',
      'top',
      'take',
      'count',
    ],
    option: 'limit',
    hint: 'use "limit" (integer 1–100)',
  },
  {
    names: [
      'page',
      'pageIndex',
      'page_index',
      'pageNumber',
      'page_number',
      'offset',
      'skip',
      'start',
      'startIndex',
    ],
    option: 'cursor',
    hint: 'there is no offset or page-number paging; pass page.meta.continuationCursor from the previous page as "cursor", or iterate with for await',
  },
  {
    names: [
      'after',
      'next',
      'nextCursor',
      'next_cursor',
      'pageToken',
      'page_token',
      'nextPageToken',
      'continuation',
      'continuationCursor',
      'continuationToken',
      'token',
      'startAfter',
    ],
    option: 'cursor',
    hint: 'pass page.meta.continuationCursor as "cursor"',
  },
  {
    names: ['filter', 'filters', 'query', 'conditions', 'criteria', 'match'],
    option: 'where',
    hint: 'use "where" with { property: value } or { property: { eq, in, gt, gte, lt, lte } }; ranges require numbers or timestamps',
  },
  {
    names: [
      'fields',
      'properties',
      'columns',
      'attributes',
      'include',
      'projection',
    ],
    option: 'select',
    hint: 'use "select" with an array of property names',
  },
  {
    names: ['sort', 'sortBy', 'sort_by', 'orderBy', 'order_by', 'order'],
    hint: 'sorting is not supported; sort the returned records',
  },
];

// Every option that is not universal pages or filters a collection.
const singleRecord =
  'this operation returns a single record and does not page or filter';

/** Why a name is not an option here, using only the generic option vocabulary. */
function unknownOption(name: string, operation: ReadOperation): RequestIssue {
  const known = rules.find((rule) => rule.name === name);

  if (known)
    return {
      path: [name],
      problem: 'not-supported',
      message: `not accepted here; ${singleRecord}.`,
    };

  const alias = aliases.find((entry) => entry.names.includes(name));
  const meant =
    alias?.option && rules.find((rule) => rule.name === alias.option);

  return {
    path: [name],
    problem: 'unknown-option',
    message:
      meant && !meant.operations.includes(operation)
        ? `unknown option; ${singleRecord}.`
        : alias
          ? `unknown option; ${alias.hint}.`
          : 'unknown option.',
  };
}

const describeValue = (value: unknown) =>
  value === null
    ? 'null'
    : Array.isArray(value)
      ? 'array'
      : typeof value === 'number' || typeof value === 'boolean'
        ? `${typeof value} ${String(value)}`
        : typeof value;

/** The caller-visible type of a value, for discovery and errors. */
export function schemaText(schema: ScalarSchema, references?: string): string {
  if (references !== undefined)
    return `${references} object ID${schema.nullable ? ' or null' : ''}`;

  if (schema.format === 'timestamp')
    return `ISO timestamp with timezone, at most millisecond precision${schema.nullable ? ' or null' : ''}`;

  const bounds: string[] = [];

  if (schema.type === 'string') {
    if (schema.minLength !== undefined && schema.maxLength !== undefined)
      bounds.push(`of ${schema.minLength}–${schema.maxLength} characters`);
    else if (schema.minLength !== undefined)
      bounds.push(`of at least ${schema.minLength} characters`);
    else if (schema.maxLength !== undefined)
      bounds.push(`of at most ${schema.maxLength} characters`);
  }

  if (schema.minimum !== undefined) bounds.push(`≥ ${schema.minimum}`);

  if (schema.exclusiveMinimum !== undefined)
    bounds.push(`> ${schema.exclusiveMinimum}`);

  if (schema.maximum !== undefined) bounds.push(`≤ ${schema.maximum}`);

  if (schema.exclusiveMaximum !== undefined)
    bounds.push(`< ${schema.exclusiveMaximum}`);

  return (
    [schema.type, ...bounds].join(' ') + (schema.nullable ? ' or null' : '')
  );
}

export function invalidValue(
  path: readonly string[],
  expected: string,
  value: unknown,
): RequestIssue {
  return {
    path,
    problem: 'invalid-value',
    message: `expected ${expected}; got ${describeValue(value)}.`,
  };
}

/** Option-level issues for one operation. Undefined values count as omitted. */
export function requestIssues(
  input: unknown,
  operation: ReadOperation,
): RequestIssue[] {
  if (!input || typeof input !== 'object' || Array.isArray(input))
    return [invalidValue([], 'an options object', input)];

  const issues: RequestIssue[] = [];

  for (const [name, value] of Object.entries(input)) {
    if (value === undefined) continue;

    const rule = rules.find(
      (candidate) =>
        candidate.name === name && candidate.operations.includes(operation),
    );

    if (!rule) issues.push(unknownOption(name, operation));
    else if (!rule.valid(value))
      issues.push(invalidValue([name], rule.type, value));
  }

  return issues;
}

/** Throw one invalid-request error naming every issue. */
export function throwIssues(
  operation: string,
  kind: ReadOperation,
  issues: readonly RequestIssue[],
): never {
  throw new ReadError('invalid-request', {
    operation,
    issues,
    ...(issues.some((issue) => issue.problem === 'unknown-option')
      ? { acceptedOptions: optionNames(kind) }
      : {}),
  });
}

/** Reject when there are issues; every issue is reported at once. */
export function rejectIssues(
  operation: string,
  kind: ReadOperation,
  issues: readonly RequestIssue[],
): void {
  if (issues.length) throwIssues(operation, kind, issues);
}

export function cursorIssue(): RequestIssue {
  return {
    path: ['cursor'],
    problem: 'invalid-cursor',
    message:
      'not valid for this call. Pass page.meta.continuationCursor from a page of this same operation with the same options; cursors expire.',
  };
}
