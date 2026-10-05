# Contributing

This repository currently contains scaffolding only. Use `pnpm install` and
`pnpm packages` to inspect the workspace. There are no build or test commands yet.

Keep runtime behavior inside domain modules and concrete infrastructure in its
adapter or host package. Published packages must not depend on examples, tests,
or development infrastructure. Simulators remain independent of Relate.

Add package-local tests with implementations. Cross-package integration,
conformance, and installed-artifact checks belong under `tests/`.
