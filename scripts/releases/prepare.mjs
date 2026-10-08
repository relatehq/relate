import { assertReleasesEnabled } from './shared.mjs';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { releasePackages, run, validateVersion } from './shared.mjs';

await assertReleasesEnabled();

const channel = process.argv[2];

if (!['alpha', 'stable'].includes(channel))
  throw new Error('Usage: pnpm release:prepare <alpha|stable>');

const pending = (await readdir('.changeset')).filter(
  (name) => name.endsWith('.md') && name !== 'README.md',
);
let pre;

try {
  pre = JSON.parse(await readFile('.changeset/pre.json', 'utf8'));
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
}

if (!pending.length && !(pre && channel === 'stable'))
  throw new Error('Add a changeset before preparing a release.');

// The dev baseline is not an alpha release. Start the first release calculation
// from its numeric base so a patch changeset produces 0.0.1-alpha.0.
if (!pre) {
  for (const pkg of await releasePackages()) {
    if (pkg.version === '0.0.0-dev.0') {
      const path = `packages/${pkg.directory}/package.json`;
      const metadata = JSON.parse(await readFile(path, 'utf8'));

      metadata.version = '0.0.0';
      await writeFile(path, JSON.stringify(metadata, null, 2) + '\n');
    }
  }
}

if (channel === 'stable') {
  if (pre) run('pnpm', ['changeset', 'pre', 'exit']);
} else if (!pre || pre.tag !== channel) {
  run('pnpm', ['changeset', 'pre', 'enter', channel]);
}

run('pnpm', ['changeset', 'version']);
run('pnpm', ['install', '--lockfile-only']);

const packages = await releasePackages();

validateVersion(packages, packages[0].version);
console.log(
  `Prepared ${packages[0].version}. Review package manifests, changelogs and prerelease state.`,
);
