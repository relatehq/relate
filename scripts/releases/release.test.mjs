import assert from 'node:assert/strict';
import test from 'node:test';
import { packedPackages, releasePackages, validateVersion } from './shared.mjs';

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

test('release inventory includes the SQLite connector and its tarball', async () => {
  const packages = await releasePackages();
  const connector = packages.find(
    (entry) => entry.name === '@relate/connector-sqlite',
  );

  assert.ok(connector);
  assert.ok(packedPackages.includes(connector.directory));
});

test('connector scaffolds are ignored but malformed manifests fail', async () => {
  const { mkdtemp, mkdir, writeFile, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const root = await mkdtemp(join(tmpdir(), 'relate-release-inventory-'));

  try {
    await mkdir(join(root, 'packages'));
    await mkdir(join(root, 'connectors', 'scaffold'), { recursive: true });
    await mkdir(join(root, 'connectors', 'sqlite'));
    await writeFile(
      join(root, 'connectors', 'sqlite', 'package.json'),
      JSON.stringify({ ...pkg, name: '@relate/connector-sqlite' }),
    );
    assert.deepEqual(
      (await releasePackages(root)).map((entry) => entry.name),
      ['@relate/connector-sqlite'],
    );
    await writeFile(
      join(root, 'connectors', 'scaffold', 'package.json'),
      '{malformed',
    );
    await assert.rejects(releasePackages(root), SyntaxError);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('development mode blocks changesets and release commands before any mutation', async () => {
  const { spawnSync } = await import('node:child_process');
  const { readFile } = await import('node:fs/promises');
  const before = await releasePackages();
  const lock = await readFile('pnpm-lock.yaml', 'utf8');

  for (const [script, ...args] of [
    ['changeset.mjs', 'version'],
    ['prepare.mjs', 'alpha'],
    ['artifacts.mjs', '0.0.0-dev.0'],
  ]) {
    const result = spawnSync(
      process.execPath,
      [`scripts/releases/${script}`, ...args],
      { encoding: 'utf8' },
    );

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /disabled during development/);
  }

  assert.deepEqual(await releasePackages(), before);
  assert.equal(await readFile('pnpm-lock.yaml', 'utf8'), lock);
});

test('CI development guard rejects changesets and public package version bumps', async () => {
  const { spawnSync } = await import('node:child_process');
  const { mkdtemp, mkdir, writeFile, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join, resolve } = await import('node:path');
  const root = await mkdtemp(join(tmpdir(), 'relate-development-policy-'));
  const check = () =>
    spawnSync(
      process.execPath,
      [resolve('scripts/releases/check-development.mjs')],
      { cwd: root, encoding: 'utf8' },
    );

  try {
    for (const dir of [
      'packages/relate',
      'connectors',
      'scripts/releases',
      '.changeset',
    ])
      await mkdir(join(root, dir), { recursive: true });

    await writeFile(
      join(root, 'scripts/releases/policy.json'),
      JSON.stringify({ enabled: false, developmentVersion: '0.0.0-dev.0' }),
    );
    const manifest = join(root, 'packages/relate/package.json');

    await writeFile(manifest, JSON.stringify(pkg));
    assert.equal(check().status, 0);
    await writeFile(join(root, '.changeset/feature.md'), 'pending');
    assert.match(check().stderr, /do not add changesets/);
    await rm(join(root, '.changeset/feature.md'));
    await writeFile(manifest, JSON.stringify({ ...pkg, version: '0.1.0' }));
    assert.match(check().stderr, /must stay at 0.0.0-dev.0/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
