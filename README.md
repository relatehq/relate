# Relate

A business graph, defined in TypeScript.

The first embedded Customer read is implemented across `relate`,
`@relate/protocol`, `@relate/runtime`, and `@relate/postgres`. It includes
source refresh, authorized durable fallback, and structured evidence. Packages
remain private and unpublished; the other packages and applications remain
scaffolds.

## Workspace

Use pnpm 12.9.1 and Node.js 26.9.0 (`.node-version`) for repository tooling.
Node 26 is the development baseline, with the latest published Node 26 type
definitions. This is not runtime compatibility certification.

```sh
pnpm install
pnpm packages
pnpm test:unit
pnpm example:hello-world
```

- `packages/relate`: main authoring API, portable app definitions, and compiler.
- `packages/runtime`: execution engine with internal domain modules.
- `packages/protocol` and `packages/client`: public contracts and HTTP
  consumption.
- `packages/http` and `packages/mcp`: transport adapters over runtime
  capabilities.
- `packages/postgres`: durable storage and physical database migrations.
- `packages/node`: Node hosting and application lifecycle.
- `packages/cli` and `packages/create-relate`: commands and project generation.
- `connectors/`: independently installable provider integrations.
- `apps/docs` and `apps/inspector`: documentation and public-API inspection.
- `examples/hello-world`: minimal authorized read with default memory storage.
- `examples/postgres-persistence`: persistent storage, refresh and restart
  recovery.
- `dev/`: reusable harnesses, independent simulators, services, and fixtures.
- `tests/`: integration, conformance, and installed-package verification.

All packages remain private. The four implemented packages expose compiled Node
ESM and TypeScript declarations. `pnpm check` runs typechecking, dependency
boundaries, focused unit/integration tests, and installed-tarball compatibility.
`pnpm test:unit` runs without a database. Custom stores implement the
[public store contract](packages/runtime/STORE_CONTRACT.md). The database tests
require `RELATE_TEST_DATABASE_URL` pointing to a dedicated existing database;
they reset its `relate` schema before and after each suite run. See
[Contributing](CONTRIBUTING.md#postgres-integration-tests) for test setup and
[Postgres persistence](examples/postgres-persistence/README.md) for
prerequisites, contracts, and current limits.

Future platform hosts belong in dedicated packages when they have integration
work to own. No root `docs/` or `experiments/` directory is included.

## License

Relate is licensed under the [Apache License 2.0](LICENSE).
