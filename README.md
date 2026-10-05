# Relate

A business graph, defined in TypeScript.

This repository is a package and directory scaffold only. No runtime, CLI,
client, application, or connector is implemented or published here yet.

## Workspace

Use pnpm 12.4.2 and Node.js 22.18 or newer for repository tooling. This is not
runtime compatibility certification.

```sh
pnpm install
pnpm packages
```

- `packages/relate`: main authoring API, portable app definitions, and compiler.
- `packages/runtime`: execution engine with internal domain modules.
- `packages/protocol` and `packages/client`: public contracts and HTTP consumption.
- `packages/http` and `packages/mcp`: transport adapters over runtime capabilities.
- `packages/postgres`: durable storage and physical database migrations.
- `packages/node`: Node hosting and application lifecycle.
- `packages/cli` and `packages/create-relate`: commands and project generation.
- `connectors/`: independently installable provider integrations.
- `apps/docs` and `apps/inspector`: documentation and public-API inspection.
- `examples/`: complete application placeholders.
- `dev/`: reusable harnesses, independent simulators, services, and fixtures.
- `tests/`: integration, conformance, and installed-package verification.

All packages are private during scaffolding. Workspace dependencies express the
intended relationships; exports, binaries, third-party dependencies, build tools,
and executable commands will be added with their implementations.

Future platform hosts belong in dedicated packages when they have integration
work to own. No root `docs/` or `experiments/` directory is included.

## License

The open-source license has not been selected. No license grant is made by this
scaffold; add the chosen license before public release.
