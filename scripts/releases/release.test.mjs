import assert from 'node:assert/strict';
import test from 'node:test';
import { validateVersion } from './shared.mjs';

const pkg = {
  name: 'relate',
  version: '0.0.0-dev.0',
  private: false,
  publishConfig: { access: 'public' },
};

test('release validation rejects mismatched versions and non-public packages', () => {
  assert.equal(validateVersion([pkg], pkg.version), true);
  assert.throws(() => validateVersion([pkg], '0.0.1'));
  assert.throws(() =>
    validateVersion([{ ...pkg, private: true }], pkg.version),
  );
  assert.throws(() =>
    validateVersion([{ ...pkg, publishConfig: {} }], pkg.version),
  );
});

test('release versions cannot inject shell or tag syntax', () => {
  for (const version of [
    'v0.0.1',
    '0.0.1;echo',
    '../main',
    '0.0.1-unknown.0',
    '0.0.1+build',
  ])
    assert.throws(() => validateVersion([{ ...pkg, version }], version));

  assert.equal(validateVersion([{ ...pkg, version: '0.0.1' }], '0.0.1'), false);
});
