import { expect, it } from 'vitest';
import type { RequestIssue } from '@relate/protocol';
import { compilePredicate, matchesPredicate } from '../src/reads/predicates.js';

it.each(['eq', 'in', 'gte'] as const)(
  'fails explicitly for invalid stored local datetime in %s filters',
  (operator) => {
    const issues: RequestIssue[] = [];
    const value = '2024-02-29T00:00:00';
    const predicate = compilePredicate(
      {
        id: 'appointment.startsAt',
        name: 'startsAt',
        schema: {
          type: 'string',
          optional: false,
          nullable: true,
          format: 'local-datetime',
          precision: 'second',
        },
      },
      { [operator]: operator === 'in' ? [value] : value },
      issues,
    );

    expect(issues).toEqual([]);
    expect(matchesPredicate(predicate, value)).toBe(true);
    expect(matchesPredicate(predicate, null)).toBe(false);

    for (const invalid of [
      value + '.000',
      value + 'Z',
      '2023-02-29T00:00:00',
      123,
    ])
      expect(() => matchesPredicate(predicate, invalid)).toThrowError(
        expect.objectContaining({ code: 'incomplete' }),
      );
  },
);

it('compares signed int64 filters exactly while keeping cursor predicates JSON-compatible', () => {
  const property = {
    id: 'balance',
    name: 'balance',
    schema: {
      type: 'string',
      format: 'int64',
      optional: false,
      nullable: true,
    },
  } as const;

  for (const [operator, threshold, matches, misses] of [
    ['gt', '20', ['100', '9007199254740993'], ['9', '-1', '20']],
    [
      'gte',
      '9007199254740993',
      ['9007199254740993', '9007199254740994'],
      ['9007199254740992'],
    ],
    ['lt', '-20', ['-100'], ['-9', '0', '-20']],
    ['lte', '-20', ['-100', '-20'], ['-19']],
    ['eq', '9007199254740993', ['9007199254740993'], ['9007199254740992']],
    [
      'in',
      ['9007199254740993', '-20'],
      ['9007199254740993', '-20'],
      ['9007199254740992', '20'],
    ],
  ] as const) {
    const issues: RequestIssue[] = [];
    const predicate = compilePredicate(
      property,
      { [operator]: threshold },
      issues,
    );

    expect(issues).toEqual([]);
    expect(JSON.parse(JSON.stringify(predicate))).toEqual(predicate);

    for (const value of matches)
      expect(matchesPredicate(predicate, value)).toBe(true);

    for (const value of [...misses, null])
      expect(matchesPredicate(predicate, value)).toBe(false);
  }

  for (const value of [1, 1n, '-0', '01', '9223372036854775808', null]) {
    const issues: RequestIssue[] = [];

    compilePredicate(property, { gt: value }, issues);
    expect(issues).toHaveLength(1);
  }
});

it('retains the int32 domain when validating range thresholds', () => {
  const property = {
    id: 'count',
    name: 'count',
    schema: {
      type: 'number',
      format: 'int32',
      optional: false,
      nullable: false,
    },
  } as const;

  for (const value of [0.5, 2147483648, -2147483649, '0']) {
    const issues: RequestIssue[] = [];

    compilePredicate(property, { gt: value }, issues);
    expect(issues).toHaveLength(1);
  }
});

it.each(['eq', 'in', 'gte'] as const)(
  'rejects malformed stored integers instead of silently omitting them for %s',
  (operator) => {
    for (const [format, type, valid, invalid] of [
      ['int32', 'number', 1, [1.5, 2147483648, '1']],
      ['int64', 'string', '1', [1, '-0', '01', '9223372036854775808']],
    ] as const) {
      const predicate = compilePredicate(
        {
          id: 'value',
          name: 'value',
          schema: {
            type,
            format,
            optional: false,
            nullable: true,
          },
        },
        { [operator]: operator === 'in' ? [valid] : valid },
        [],
      );

      for (const value of invalid)
        expect(() => matchesPredicate(predicate, value)).toThrowError(
          expect.objectContaining({ code: 'incomplete' }),
        );
    }
  },
);
