import assert from 'node:assert/strict';
import test from 'node:test';
import {
  assertReleasesEnabled,
  readReleasePolicy,
  packedPackages,
  releasePackages,
  validateVersion,
} from './shared.mjs';

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

test('release inventory includes both connectors and their tarballs', async () => {
  const packages = await releasePackages();
  const connector = packages.find(
    (entry) => entry.name === '@relate/connector-sqlite',
  );

  assert.ok(connector);
  assert.equal(connector.directory, 'connectors/sqlite');
  assert.ok(packedPackages.includes(connector.directory));
  const stripe = packages.find(
    (entry) => entry.name === '@relate/connector-stripe',
  );

  assert.ok(stripe);
  assert.equal(stripe.directory, 'connectors/stripe');
  assert.ok(packedPackages.includes(stripe.directory));
  assert.equal(
    packages.find((entry) => entry.name === 'relate').directory,
    'packages/relate',
  );
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

test('development mode blocks changesets and release commands in an isolated root', async () => {
  const { spawnSync } = await import('node:child_process');
  const { mkdtemp, mkdir, readFile, writeFile, readdir, rm } =
    await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const root = await mkdtemp(join(tmpdir(), 'relate-disabled-commands-'));

  try {
    await mkdir(join(root, 'scripts/releases'), { recursive: true });
    const policy = JSON.stringify({
      enabled: false,
      developmentVersion: '0.0.0-dev.0',
    });

    await writeFile(join(root, 'scripts/releases/policy.json'), policy);

    for (const [script, ...args] of [
      ['changeset.mjs', 'version'],
      ['prepare.mjs', 'alpha'],
      ['artifacts.mjs', '0.0.0-dev.0'],
    ]) {
      const result = spawnSync(
        process.execPath,
        [fileURLToPath(new URL(script, import.meta.url)), ...args],
        { cwd: root, encoding: 'utf8' },
      );

      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /disabled during development/);
    }

    assert.equal(
      await readFile(join(root, 'scripts/releases/policy.json'), 'utf8'),
      policy,
    );
    assert.deepEqual(await readdir(root), ['scripts']);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
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

test('policy parsing fails closed consistently for malformed values', async () => {
  const { spawnSync } = await import('node:child_process');
  const { mkdtemp, mkdir, writeFile, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const root = await mkdtemp(join(tmpdir(), 'relate-policy-types-'));
  const path = join(root, 'scripts/releases/policy.json');

  try {
    await mkdir(join(root, 'scripts/releases'), { recursive: true });

    for (const enabled of ['false', 'true', 0, 1, null]) {
      await writeFile(
        path,
        JSON.stringify({ enabled, developmentVersion: '0.0.0-dev.0' }),
      );
      await assert.rejects(readReleasePolicy(root), /Invalid release policy/);
      await assert.rejects(
        assertReleasesEnabled(root),
        /Invalid release policy/,
      );
      const check = spawnSync(
        process.execPath,
        [fileURLToPath(new URL('check-development.mjs', import.meta.url))],
        { cwd: root, encoding: 'utf8' },
      );

      assert.notEqual(check.status, 0);
      assert.match(check.stderr, /Invalid release policy/);
    }

    await writeFile(
      path,
      JSON.stringify({ enabled: true, developmentVersion: '0.0.0-dev.0' }),
    );
    await assertReleasesEnabled(root);
    assert.equal((await readReleasePolicy(root)).enabled, true);
    // The command-guard test must still pass when its invoking checkout is enabled:
    // it creates its own disabled root rather than executing commands here.
    const test = spawnSync(
      process.execPath,
      [
        '--test',
        '--test-name-pattern=development mode blocks',
        fileURLToPath(import.meta.url),
      ],
      { cwd: root, encoding: 'utf8' },
    );

    assert.equal(test.status, 0, test.stdout + test.stderr);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
