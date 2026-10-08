import { readdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import semver from 'semver';

export const packedPackages = [
  'packages/protocol',
  'packages/relate',
  'packages/runtime',
  'packages/postgres',
  'packages/node',
  'connectors/sqlite',
];

export function run(command, args, options = {}) {
  return execFileSync(command, args, { stdio: 'inherit', ...options });
}

export async function releasePackages(root = process.cwd()) {
  const directories = (
    await Promise.all(
      ['packages', 'connectors'].map(async (directory) =>
        (await readdir(resolve(root, directory), { withFileTypes: true }))
          .filter((entry) => entry.isDirectory())
          .map((entry) => `${directory}/${entry.name}`),
      ),
    )
  ).flat();
  const packages = [];

  for (const directory of directories.sort()) {
    let content;

    try {
      content = await readFile(
        resolve(root, directory, 'package.json'),
        'utf8',
      );
    } catch (error) {
      if (error.code === 'ENOENT') continue;

      throw error;
    }

    const metadata = JSON.parse(content);

    packages.push({ directory, ...metadata });
  }

  return packages;
}

export function validateVersion(packages, version) {
  if (
    !semver.valid(version) ||
    !/^[0-9]+\.[0-9]+\.[0-9]+(?:-(?:dev|alpha|beta|rc)\.[0-9]+)?$/.test(version)
  )
    throw new Error(
      'Expected a stable version or a dev/alpha/beta/rc numbered prerelease.',
    );

  for (const pkg of packages) {
    if (
      pkg.version !== version ||
      pkg.private !== false ||
      pkg.publishConfig?.access !== 'public'
    )
      throw new Error(`${pkg.name} must be public and version ${version}.`);
  }

  return semver.prerelease(version) !== null;
}

/** Release activation is a reviewed repository change, never an environment override. */
export async function readReleasePolicy(root = process.cwd()) {
  const policy = JSON.parse(
    await readFile(resolve(root, 'scripts/releases/policy.json'), 'utf8'),
  );

  if (
    typeof policy?.enabled !== 'boolean' ||
    typeof policy.developmentVersion !== 'string' ||
    !semver.valid(policy.developmentVersion)
  )
    throw new Error(
      'Invalid release policy: enabled must be a boolean and developmentVersion must be a valid version.',
    );

  return {
    enabled: policy.enabled,
    developmentVersion: policy.developmentVersion,
  };
}

export async function assertReleasesEnabled(root = process.cwd()) {
  const policy = await readReleasePolicy(root);

  if (!policy.enabled)
    throw new Error(
      'Releases and changesets are disabled during development. Keep package versions unchanged; describe changes in the PR.',
    );
}
