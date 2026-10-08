# Releasing Relate

> Relate is currently `0.0.0-dev.0`: a development baseline for discussion and
> contribution only. It is not ready for application use. APIs and behavior are
> incomplete and may change without notice.

## Development mode: releases are disabled

Do not add changesets, change package versions, or run release preparation in
feature PRs. Describe behavior and validation in the PR. All public packages
stay at `0.0.0-dev.0`. Pending changesets have been removed. Their migration
guidance is preserved in [DEVELOPMENT_NOTES.md](DEVELOPMENT_NOTES.md), outside
release automation.

`scripts/releases/policy.json` sets `enabled: false`. The `pnpm changeset`,
`pnpm release:prepare`, and `pnpm release:artifacts` commands fail before
changing files. Both release workflows check the same policy before creating
release branches, tags, or GitHub releases. CI's `pnpm check:development`
rejects pending changesets, prerelease state, and package version bumps. Build
and installed-package tests still run locally and in CI; temporary test tarballs
are not releases.

To begin releasing, obtain an explicit owner decision and make a separate
reviewed PR enabling that policy, choosing the first version and release scope,
incorporating [development migration notes](DEVELOPMENT_NOTES.md) into the first
release notes and migration guide, and updating this document. The procedures
below describe the dormant release tooling and must not be run while development
mode is active.

## What is versioned

Public packages under `packages/` and implemented connectors under `connectors/`
share one version through a Changesets fixed package group. They are Apache-2.0
OSS and declare public npm access. The root, apps, and examples remain
`private: true` because they are not npm distribution packages; that flag does
not make their source proprietary.

A release has one annotated repository tag, `v<VERSION>`, and one GitHub
release. The tag identifies the validated commit. GitHub provides its source
archives. Tarballs and SHA-256 checksums are attached for `relate`,
`@relate/protocol`, `@relate/runtime`, `@relate/postgres`, `@relate/node`, and
`@relate/connector-sqlite`, which have installed package checks. Client, HTTP,
MCP, CLI, and generator packages are unfinished: they share the version but are
available only in the source snapshot for now.

No workflow publishes to npm. Making package metadata public does not publish
it.

## Record changes after release activation

Only after release activation, record a meaningful change with:

```sh
pnpm changeset
```

Select the affected packages, a patch/minor/major impact, and a short
description of what changes for a caller. Commit the generated `.changeset/*.md`
file with the implementation. A change to one package bumps the whole fixed
group. Documentation or tooling changes that do not affect consumers need no
changeset.

## One-time GitHub setup

In repository Settings → Actions → General, allow GitHub Actions to create pull
requests if organization policy permits it. The current organization policy
blocks this: preparation still pushes the release branch and prints a compare
link in the workflow summary; open the PR from that link. The prepare workflow
needs contents and pull-request write permission; the release workflow needs
contents write permission. No npm credentials are needed. Both manual workflows
must be run against `main`.

PRs created with the default GitHub Actions token do not automatically trigger
other workflows. After preparation, manually run CI on the release branch using
GitHub CLI, or use a separately configured GitHub App token if automatic PR CI
is desired. The Release workflow always validates the merged commit itself.

```sh
gh workflow run ci.yml --ref release/0.0.1-alpha.0
```

## Prepare a release

1. Ensure change notes are merged into `main`.
2. Open Actions → Prepare release → Run workflow, select `main` and the channel
   (`alpha` or `stable`). The default is `alpha`.
3. Open the PR from the workflow summary if the bot could not create it. Review
   the resulting `release/<VERSION>` PR: package versions, changelogs,
   `.changeset/pre.json`, and lockfile. Review the calculated version rather
   than assuming a particular number: change impacts determine the next base
   version.
4. Validate and merge that PR before running Release.

CLI equivalent:

```sh
gh workflow run prepare-release.yml --ref main -f channel=alpha
```

The first alpha uses Changesets prerelease mode. Subsequent preparations advance
the prerelease counter when there are new change notes. Selecting stable exits
prerelease mode and removes the suffix. Development and alpha releases do not
imply production readiness. The first stable release must have explicitly
documented usable scope.

`0.0.0-dev.0` is the initial baseline, not an automatic snapshot counter. We do
not automatically produce `dev.N` builds on every commit.

To prepare locally instead, use a clean feature branch and:

```sh
pnpm install --frozen-lockfile
pnpm release:prepare alpha
```

Review and commit the generated changes, push that branch, and open a PR. Do not
run preparation twice on the same unmerged changes. If the manual workflow fails
after pushing its branch, open the PR from that existing branch. An existing
release branch is never force-pushed by this workflow.

## Create the GitHub release

After the release PR is merged:

1. Open Actions → Release → Run workflow.
2. Select `main` and enter the exact package version without `v`, for example
   `0.0.1-alpha.0`.
3. Watch the workflow and inspect the release page and attached assets.

```sh
gh workflow run release.yml --ref main -f version=0.0.1-alpha.0
```

The workflow checks the shared version/public metadata, formatting, lint, types,
package boundaries, unit and Postgres integration tests, release validation, and
installed-package compatibility. It packs the implemented packages listed above,
creates `v<VERSION>` on the checked commit, and creates a draft GitHub release
with changelog-derived notes. It uploads tarballs and `SHA256SUMS`, then makes
the release public. Versions with suffixes are marked prereleases and never
marked latest; stable releases are marked latest.

The `0.0.0-dev.0` baseline is not being released. No release is created by
merging a feature PR.

If upload or release creation fails, rerun the same workflow run so it uses the
same commit. It accepts an existing tag only when that tag points to that commit
and resumes uploads. Never move a released tag to a different commit. Fixes go
into a new version.

To check a downloaded tarball on Linux:

```sh
sha256sum -c SHA256SUMS
```

## Enable npm publishing later

Before adding npm publication:

1. Confirm ownership and availability of `relate`, `create-relate`, and the
   `@relate` scope. Current names are declarations, not proof of registry
   rights.
2. Finish the remaining packages and add build/export/installed-package checks
   before including them in npm distribution.
3. Configure npm trusted publishing for each package and the chosen GitHub
   workflow. Handle first-package registration using npm's current requirements.
4. Add a manual Publish to npm workflow that accepts an existing release tag,
   validates its artifacts, and publishes those exact versions. It must not bump
   versions or create another repository release.
5. Explicitly use npm dist-tags `alpha`, `beta`, or `rc` for prereleases and
   `latest` for stable releases. Do not use `latest` for a first alpha publish.

npm publication cannot be rolled back like a Git commit. On partial publication,
retry only missing packages of the same version. Do not replace published bytes
or reuse the version for different code. A later fix requires a new version.

References: [Changesets](https://github.com/changesets/changesets),
[GitHub release CLI](https://cli.github.com/manual/gh_release_create), and
[npm trusted publishing](https://docs.npmjs.com/trusted-publishers/).
