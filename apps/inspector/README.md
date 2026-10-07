# Inspector

Developer tooling for inspecting a Relate application.

Scaffold only; no application is implemented.

The [inspector specification](./SPEC.md) records the agreed foundation and
proposed APIs. The first screen is a live model graph using React Flow and ELK
(`elkjs`), updated from compiled Manifest snapshots when local code changes.

The new inspector uses a prebuilt React/Vite SPA served by a stable Hono
supervisor, with user definitions loaded in a replaceable child process. Next.js
remains the docs framework; it is no longer the planned inspector framework.
Vite fits the packaged static client and avoids requiring a Next server for
local inspection or a future production mount.

See the spec for `defineGraph` -> `defineApp` -> compilation/runtime examples,
embedding Relate in a larger application, package ownership, reload contracts,
and acceptance criteria. All CLI and app-lifecycle examples are proposals until
implemented.
