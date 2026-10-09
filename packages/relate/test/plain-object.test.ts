import { runInNewContext } from 'node:vm';
import { expect, it } from 'vitest';
import { isPlainObject } from 'relate/model';

class Payload {
  transaction = 't1';
}

it.each([
  ['an object literal', { transaction: 't1' }],
  ['a null-prototype object', Object.create(null) as object],
  // A sandbox (vm, iframe, agent REPL) has its own Object.prototype.
  [
    'an object literal from another realm',
    runInNewContext('({ transaction: "t1" })'),
  ],
  [
    'a null-prototype object from another realm',
    runInNewContext('Object.create(null)'),
  ],
])('accepts %s', (_, value) => {
  expect(isPlainObject(value)).toBe(true);
});

it.each([
  ['null', null],
  ['a string', 'transaction'],
  ['an array', [{ transaction: 't1' }]],
  ['an array from another realm', runInNewContext('[]')],
  ['a class instance', new Payload()],
  [
    'a class instance from another realm',
    runInNewContext('new (class Payload {})()'),
  ],
  [
    'a class instance with a spoofed tag',
    Object.assign(new Payload(), { [Symbol.toStringTag]: 'Object' }),
  ],
  ['a Map', new Map([['transaction', 't1']])],
  ['a Date', new Date(0)],
  ['a Date from another realm', runInNewContext('new Date(0)')],
])('rejects %s', (_, value) => {
  expect(isPlainObject(value)).toBe(false);
});
