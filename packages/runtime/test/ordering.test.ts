import { expect, it } from 'vitest';
import { compareObservation, OrderingConflict } from '@relate/runtime/storage';
import type { Observation } from '@relate/runtime/storage';

const observation = (
  token: string,
  name = 'A',
  version?: string,
): Observation => ({
  state: 'present',
  raw: { name },
  values: { name },
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
