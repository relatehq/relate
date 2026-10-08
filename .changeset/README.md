# Changesets are disabled during development

Do not add changesets or change package versions in feature PRs. Describe the
change in the PR instead. All public packages remain at `0.0.0-dev.0`. Preserve
breaking-change and migration guidance in
[DEVELOPMENT_NOTES.md](../DEVELOPMENT_NOTES.md).

`pnpm changeset` and release commands are guarded, and `pnpm check:development`
rejects pending changesets, prerelease state, and version bumps in CI. See
[RELEASING.md](../RELEASING.md) for the explicit release activation process.
