import { expect, it } from 'vitest';
import { assertFields } from 'relate';
import { ReadError } from '@relate/protocol';
import type { ReadResult } from '@relate/protocol';

function result(data: Record<string, unknown>) {
  return { status: 'ok' as const, data };
}

it('accepts present nullable and falsy values without mutating the result', () => {
  const read = Object.freeze({
    status: 'ok' as const,
    data: Object.freeze({ name: '', manager: null, balance: 0, active: false }),
  });

  expect(
    assertFields(read, ['name', 'manager', 'balance', 'active']),
  ).toBeUndefined();
  expect(read.data).toEqual({
    name: '',
    manager: null,
    balance: 0,
    active: false,
  });
});

it.each([
  { status: 'not-found' as const },
  result({ name: 'Ada' }),
  result({ name: 'Ada', manager: undefined }),
  result(Object.create({ manager: 'hidden' })),
])('rejects an unusable result with the same non-disclosing error', (read) => {
  expect(() => assertFields(read, ['manager'])).toThrow(
    new ReadError('incomplete'),
  );

  try {
    assertFields(read, ['manager']);
  } catch (error) {
    expect(error).toBeInstanceOf(ReadError);
    expect(error).toMatchObject({ name: 'ReadError', code: 'incomplete' });
  }
});

it('checks every requested field and accepts dynamic lists and duplicates', () => {
  const read = result({ name: 'Ada', status: 'active' });
  const fields: string[] = ['name', 'status'];

  assertFields(read, fields);
  assertFields(read, ['name', 'name']);
  expect(() => assertFields(read, ['name', 'missing'])).toThrow(ReadError);
  expect(() => assertFields(result({}), ['toString'])).toThrow(ReadError);
});

it('requires an ok result even when no fields are requested', () => {
  assertFields(result({}), []);
  expect(() => assertFields({ status: 'not-found' }, [])).toThrow(ReadError);
});

it('accepts stale values despite partial evidence and preserves all metadata', () => {
  const read: ReadResult = {
    status: 'ok',
    data: { name: 'Ada' },
    meta: {
      completeness: 'partial',
      degraded: true,
      definitionRevision: 'revision',
      warnings: [],
      fields: {
        name: {
          status: 'available',
          freshness: 'stale',
          observedAt: '2026-10-06T00:00:00.000Z',
          source: 'source',
          retention: 'confirmed',
          retentionDurability: 'volatile',
          ordering: 'confirmed',
          refresh: 'unavailable',
        },
        manager: { status: 'unavailable' },
      },
    },
  };
  const before = structuredClone(read);

  assertFields(read, ['name']);
  expect(read).toEqual(before);
  expect(() => assertFields(read, ['manager'])).toThrow(ReadError);
});

it('does not equate complete evidence with a supplied value', () => {
  const read = { ...result({}), meta: { completeness: 'complete' } };

  expect(() => assertFields(read, ['manager'])).toThrow(ReadError);
});
