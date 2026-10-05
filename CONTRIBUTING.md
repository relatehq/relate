# Contributing

Placeholder, we will fill in later.

Dependency updates use the latest stable releases, with exact versions retained
in manifests and the lockfile. Check with `pnpm outdated -r`; keep duplicated
runtime dependencies aligned across packages and examples.

Use TypeScript 6.0.3, the latest stable 6.x release, for builds, typechecks,
ESLint, and dependency-boundary checks. This is the current exception to the
latest-major policy: the tooling still requires the TypeScript 6 JavaScript API.
Keep one TypeScript dependency until the tooling supports the new API.

Use Node 26.9.0 from `.node-version`. `@types/node` 26.6.4 is the latest
published Node 26 type package at this update; its version does not exactly
match the runtime's version. Keep the runtime and types on the same major when
upgrading.
