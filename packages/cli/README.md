# @relate/cli

> Development baseline (`0.0.0-dev.0`), for discussion and contribution only.
> Not ready for application use. APIs and behavior are incomplete and may change
> without notice.

> [!WARNING]
>
> `relate dev` is implemented; other commands do not exist yet.

Development and operational commands using programmatic APIs.

## `relate dev`

Serve the [inspector](../../apps/inspector/README.md) for the project's Relate
definitions and reload it on save. The command never starts the application's
own server, runtime, database or connectors: a replaceable child process imports
the selected config, compiles `app.graph` with `relate/compiler` and reports a
Manifest or structured diagnostics over IPC.

```sh
pnpm relate dev
pnpm relate dev --config ./packages/business/relate.config.ts
pnpm relate dev --port 4500 --open
pnpm relate dev --eval-timeout 60000
pnpm relate dev --allowed-origin https://my-private-forward.example
```

The config is an entry module exporting `defineApp(...)` from `relate` (or a
`defineGraph(...)` result) as its default export:

```ts
// relate.config.ts
export { default } from './src/relate/app.js';
```

Top-level imports of that module must be safe to evaluate; put connector and
credential work in `setup`, which the inspector never calls.

### What it prints

```text
  Relate dev
  Project    /work/my-product
  Config     relate.config.ts
  Inspector  http://127.0.0.1:4318/#token=…
  Watching   application definitions
  Loading    attempt 1

  ready  gen 1  business  3 objects · 2 sources · 2 relationships  142ms
  update src/relate/objects.ts          gen 2  +AccountReview.score  61ms
  error  src/relate/graph.ts            attempt 3  1 issue; keeping gen 2
    policy.unknown-role: Unknown policy role 'finanse' in policy Invoice.read
    src/relate/graph.ts:24:22 (graph declaration)
    Graph path: policies.Invoice.read.gate
    Definition: business.invoice
```

- The inspector URL is printed and usable before the first model loads. Its
  fragment carries a per-instance bootstrap token; the page exchanges it for an
  HttpOnly, SameSite=Strict session cookie. Visiting the bare URL shows how to
  open the terminal link instead.
- Successful loads advance the generation; failed attempts keep the last good
  model on screen and print structured diagnostics with `path:line:column`
  tokens relative to the invoking directory.
- Child `console.log`/`console.error` output is forwarded line by line as
  `[app attempt N stdout]` / `[app attempt N stderr]`; it never becomes a
  protocol message.
- Output is append-only and plain text when redirected or `NO_COLOR` is set.
  Standard output carries the banner, lifecycle lines and child stdout; standard
  error carries diagnostics, warnings and child stderr.

### Ports, locks and processes

- Binds `127.0.0.1` on the first free port from 4318 through 4327, or exactly
  `--port`. An occupied explicit port fails.
- One server per project, where the project is the real path of the directory
  holding the config. The lock and owner metadata live under
  `<project>/.relate/dev/` (gitignored). A second invocation prints the running
  server's URL and exits 0; `--open` opens it. A dead owner's lock is reclaimed
  automatically; an unverifiable one is reported and left intact. Reclamation
  uses an exclusive `lock.json.reclaim` guard. If a process crashes during
  reclamation, stop any remaining dev servers before removing the guard named in
  the error and retrying.
- Each attempt bundles the config with esbuild (project modules only;
  dependencies load from `node_modules`), writes it under `.relate/dev/build/`
  and runs it in a fresh Node child with source maps enabled. Loading and
  compiling must finish within `--eval-timeout` milliseconds (default 30000) or
  the attempt fails with `worker.timeout` and the child is terminated.
- Environment variables are inherited from the invoking shell; the command loads
  no `.env` files. Use the project's own loader:
  `pnpm exec dotenvx run -f .env -- pnpm relate dev`.
- Ctrl+C stops the watcher, terminates owned children (five seconds of grace, or
  immediately on a second Ctrl+C), closes the listener and releases the lock.
  Exit codes: 0 normal, 1 fatal startup or supervisor failure, 2 invalid
  arguments.

### Endpoints

All responses are `no-store`; Host is validated against the loopback origin plus
any `--allowed-origin`, and cross-site fetches are rejected.

| Route               | Session | Purpose                                                      |
| ------------------- | ------- | ------------------------------------------------------------ |
| `GET /`             | no      | Inspector shell (`no-cache`, strict CSP)                     |
| `GET /assets/*`     | no      | Content-hashed assets (`immutable`)                          |
| `GET /dev/instance` | no      | `{ instanceId, protocolVersion, ownerId }` for lock checks   |
| `POST /dev/session` | no      | Exchange `{ token }` for the session cookie; Origin required |
| `GET /dev/snapshot` | yes     | Current model, failure and sequence                          |
| `GET /dev/events`   | yes     | SSE: snapshot first, then `model` / `diagnostics` events     |

The wire shapes are validated with `@relate/inspector/protocol`.

## Programmatic API

`@relate/cli` exports the pieces `relate dev` is built from for tests and
embedding: `runDev`, `parseDevArguments`, `resolveProject`, `acquireLock`,
`bindLoopback`, `createSessions`, `createDevServer`, `Supervisor`,
`createBuilder`, `createWatcher`, `createAttemptRunner`, `createTerminal`,
`diffManifests` and `summarizeDiff`.

## Not yet implemented

- Type diagnostics (`typecheck` events) from a watch-mode type checker.
- Telemetry; no collector exists in this scope.
- Watching non-imported files read at evaluation time.
- Operational commands such as running `@relate/postgres` migrations.
