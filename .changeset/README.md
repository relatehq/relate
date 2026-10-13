# Changesets are disabled during development

Do not add changesets or change package versions in feature PRs. Describe the
change in the PR instead. All public packages remain at `0.0.0-dev.0`. Before
the first release, breaking-change tracking and migration notes are not
required.

`pnpm changeset` and release commands are guarded, and `pnpm check:development`
rejects pending changesets, prerelease state, and version bumps in CI. See
[RELEASING.md](../RELEASING.md) for the explicit release activation process.
