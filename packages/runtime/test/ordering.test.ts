import { expect, it } from 'vitest';
import fc from 'fast-check';
import {
  compareObjectIds,
  compareObservation,
  OrderingConflict,
} from '@relate/runtime/storage';
import type { Observation } from '@relate/runtime/storage';

const observation = (
  token: string,
  name = 'A',
  version?: string,
): Observation => ({
  state: 'present',
  raw: { name },
  values: { 'person.name': name },
  observedAt: 1,
  token,
  ...(version ? { version: { domain: 'v1', value: version } } : {}),
});

it('orders unversioned observations by fetch start, never response arrival', () => {
  expect(compareObservation(observation('2', 'B'), observation('1'))).toBe(
    'superseded',
  );
  expect(compareObservation(observation('1'), observation('2', 'B'))).toBe(
    'changed',
  );
  expect(compareObservation(observation('1'), observation('2'))).toBe(
    'unchanged',
  );
  expect(compareObservation(observation('1'), observation('1'))).toBe('replay');
});
it('prefers comparable provider versions and rejects ambiguous evidence', () => {
  expect(
    compareObservation(observation('5', 'A', '1'), observation('3', 'B', '2')),
  ).toBe('changed');
  expect(
    compareObservation(observation('3', 'B', '2'), observation('5', 'A', '1')),
  ).toBe('superseded');
  expect(() =>
    compareObservation(observation('1', 'A', '1'), observation('2', 'B', '1')),
  ).toThrow(OrderingConflict);
  expect(() =>
    compareObservation(observation('1', 'A', '1'), observation('2')),
  ).toThrow(OrderingConflict);
  expect(() =>
    compareObservation(observation('1'), observation('1', 'B')),
  ).toThrow(OrderingConflict);
});

it('orders object IDs by UTF-8 bytes, including astral and lone surrogate units', () => {
  const unit = fc.oneof(
    fc.constantFrom('a', 'b', '\uffff', '\ud800', '\udc00', '\u{1f600}'),
    fc.integer({ min: 0, max: 0xffff }).map((n) => String.fromCharCode(n)),
  );
  const id = fc.string({ unit, maxLength: 6 });

  fc.assert(
    fc.property(id, id, (a, b) => {
      expect(compareObjectIds(a, b)).toBe(
        Buffer.compare(Buffer.from(a), Buffer.from(b)),
      );
    }),
    { numRuns: 20_000 },
  );
  expect(compareObjectIds('\uffff', '\u{1f600}')).toBe(-1);
  expect(compareObjectIds('\ud800', '\ud800\udc00')).toBe(-1);
});
