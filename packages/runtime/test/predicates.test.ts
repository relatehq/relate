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
