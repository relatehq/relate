# Inspector

Developer tooling for inspecting a Relate application: a live model graph of the
project's object types and relationships, served by
[`relate dev`](../../packages/cli/README.md) and updated from compiled Manifest
snapshots as local code changes.

The [specification](./SPEC.md) records the agreed foundation; this package is
its first implementation. One screen exists: the model graph, built with React
Flow and ELK (`elkjs`) in a Web Worker, with a side panel for diagnostics and
selection details.

## Layout

```text
apps/inspector/
  index.html, vite.config.ts     Vite SPA; prebuilt into dist/client
  src/protocol.ts                validated DevEvent / Diagnostic / snapshot DTOs
  src/server.ts                  Hono mount for the packaged shell and assets
  src/connection/                session bootstrap, SSE client, state reducer
  src/graph/                     Manifest -> nodes/edges, React Flow view
  src/layout/                    ELK adapter and worker engine
  src/panel/, src/screens/       side panel, graph screen, shell
  src/styles.css                 design tokens (twenty-ui theme port)
```

Two entry points are exported:

- `@relate/inspector/protocol` (browser-safe): `parseDevEvent`,
  `readProtocolVersion`, `PROTOCOL_VERSION`, the zod schemas and TypeScript
  types for `DevEvent`, `Diagnostic`, `ModelSnapshot` and `ManifestDiff`. It
  depends on `relate/model` and `relate/diagnostics` only.
- `@relate/inspector/server` (Node): `createInspectorApp({ basePath })` returns
  a Hono app that serves the shell with `Cache-Control: no-cache` and a
  restrictive CSP, hashed assets as `immutable`, and 404 for anything else.

Browser code never imports the compiler, runtime, connectors or user modules;
`tests/boundaries.mjs` enforces that.

## Behavior

- The terminal link carries `#token=…`; the page removes it with `replaceState`,
  exchanges it at `POST dev/session` for an HttpOnly cookie, loads
  `dev/snapshot` and subscribes to `dev/events`. Without a session the page
  explains how to open the terminal link.
- Events are validated and applied in sequence. Duplicates are ignored; a gap or
  a new instance resynchronizes from a snapshot. Late models and older attempts
  never replace newer ones.
- Three states are kept distinct: invalid authored code (compile, syntax, import
  diagnostics with codes, paths, definitions and sites), loader failure
  (`worker.*`, presented as not your code), and connection loss (a dimmed stale
  graph, never a diagnostic). An unsupported `protocolVersion` or an invalidated
  session keeps the last graph as stale and offers one explicit reload.
- Nodes use `object.id` and edges `relationship.id` as identity, so label edits
  never recreate elements. Selection and the camera survive updates; the view
  fits automatically only on the first non-empty model. Layout reruns only when
  topology changes; a failed layout keeps the previous placement with a visible
  diagnostic.
- Type diagnostics (`typecheck` events) are accepted and rendered as warnings,
  but no checker emits them yet.

## Development

```sh
pnpm --filter @relate/inspector build     # dist/server + dist/client
pnpm --filter @relate/inspector dev       # Vite HMR for inspector work
pnpm relate dev                           # serves the prebuilt client
```
