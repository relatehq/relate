import { readFile, readdir } from 'node:fs/promises';
import { releasePackages } from './shared.mjs';

const policy = JSON.parse(
  await readFile('scripts/releases/policy.json', 'utf8'),
);

if (!policy.enabled) {
  const entries = await readdir('.changeset');

  if (
    entries.some(
      (name) =>
        name === 'pre.json' || (name.endsWith('.md') && name !== 'README.md'),
    )
  )
    throw new Error(
      'Development mode: do not add changesets or enter prerelease mode. Describe changes in the PR.',
    );

  for (const pkg of await releasePackages()) {
    if (pkg.version !== policy.developmentVersion)
      throw new Error(
        `Development mode: ${pkg.name} must stay at ${policy.developmentVersion}.`,
      );
  }

  console.log(
    'Development mode: no changesets, prerelease state, or package version bumps.',
  );
}
