import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import {
  packedPackages,
  releasePackages,
  run,
  validateVersion,
} from './shared.mjs';

const version = process.argv[2];
const packages = await releasePackages();
const prerelease = validateVersion(packages, version);
const destination = resolve('release-artifacts');

await mkdir(destination, { recursive: true });

const notes = [
  `# Relate ${version}`,
  '',
  ...(prerelease
    ? [
        '> Development preview. APIs and behavior may change without notice.',
        '',
        ...(version.includes('-dev.')
          ? [
              '> For discussion and contribution only. Not ready for application use.',
              '',
            ]
          : []),
      ]
    : []),
  'Tarballs are provided for the five packages covered by installed-package checks.',
  'The remaining packages are unfinished and available in the source archive only.',
  '',
];
const checksums = [];

for (const pkg of packages) {
  if (packedPackages.includes(pkg.directory)) {
    run('pnpm', ['pack', '--pack-destination', destination], {
      cwd: resolve('packages', pkg.directory),
    });
    const filename = `${pkg.name.replace('@', '').replace('/', '-')}-${version}.tgz`;
    const bytes = await readFile(resolve(destination, filename));

    checksums.push(
      `${createHash('sha256').update(bytes).digest('hex')}  ${filename}`,
    );
  }

  try {
    const changelog = await readFile(
      resolve('packages', pkg.directory, 'CHANGELOG.md'),
      'utf8',
    );
    const section = changelog.split(`\n## ${version}\n`)[1]?.split(/\n## /)[0];

    if (section) notes.push(`## ${pkg.name}`, section.trim(), '');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
}

await writeFile(
  resolve(destination, 'SHA256SUMS'),
  checksums.join('\n') + '\n',
);
await writeFile(
  resolve(destination, 'release-notes.md'),
  notes.join('\n') + '\n',
);

if (process.env.GITHUB_OUTPUT)
  await writeFile(process.env.GITHUB_OUTPUT, `prerelease=${prerelease}\n`, {
    flag: 'a',
  });
