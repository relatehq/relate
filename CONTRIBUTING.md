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

## Postgres integration tests

Provision an existing, dedicated test database using your own Postgres server
(for example, one running in Docker), then run:

```sh
RELATE_TEST_DATABASE_URL=postgresql://localhost/relate_test pnpm test:integration
```

The URL includes the database name. The role must own the `relate` schema or
have permission to create it. The suite drops that schema before and after the
run and applies migrations during setup; use a disposable test database. Other
schemas are left alone. Integration files run serially because they share the
schema and inject database triggers. Do not run separate test commands against
the same test database concurrently.

`pnpm test` and `pnpm check` also require `RELATE_TEST_DATABASE_URL`.
`pnpm test:unit` needs no database. Tests never fall back to `DATABASE_URL`,
create databases, or start/stop Postgres. Compose provisioning can be added
later without changing this contract.
