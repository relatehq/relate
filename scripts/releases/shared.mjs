import { readdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import semver from 'semver';

export const packedPackages = [
  'protocol',
  'relate',
  'runtime',
  'postgres',
  'node',
  '../connectors/sqlite',
];

export function run(command, args, options = {}) {
  return execFileSync(command, args, { stdio: 'inherit', ...options });
}

export async function releasePackages(root = process.cwd()) {
  const directories = [
    ...(await readdir(resolve(root, 'packages'))),
    ...(await readdir(resolve(root, 'connectors'), { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => `../connectors/${entry.name}`),
  ];
  const packages = [];

  for (const directory of directories.sort()) {
    const metadata = JSON.parse(
      await readFile(
        resolve(root, 'packages', directory, 'package.json'),
        'utf8',
      ),
    );

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
