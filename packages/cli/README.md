# @relate/cli

> Development baseline (`0.0.0-dev.0`), for discussion and contribution only.
> Not ready for application use. APIs and behavior are incomplete and may change
> without notice.

Command-line entry point for Relate. Only `relate dev` is implemented.

## `relate dev`

Start the local development service and print the Inspector URL. Application
code reloads on save while the Inspector keeps its selection, camera and editor
tabs.

```sh
pnpm relate dev
pnpm relate dev --config ./packages/business/relate.config.ts
pnpm relate dev --port 4500 --open
pnpm relate dev --eval-timeout 60000
pnpm relate dev --no-runtime
pnpm relate dev --seed
pnpm relate dev --rotate-mcp-token
pnpm relate dev --allowed-origin https://my-private-forward.example
```

| Option                      | Behavior                                                       |
| --------------------------- | -------------------------------------------------------------- |
| `--config <path>`           | Select a config exporting a Relate app or graph                |
| `--port <number>`           | Bind this port; otherwise try 4318–4327                        |
| `--open`                    | Open the Inspector in a browser (off by default)               |
| `--quiet`                   | Hide status chatter; retain URLs, diagnostics and child output |
| `--no-runtime`              | Inspect definitions without running setup or opening a store   |
| `--seed`                    | Run the config's seed function on each runtime start           |
| `--rotate-mcp-token`        | Replace the saved MCP bearer token                             |
| `--eval-timeout <ms>`       | Set the compile/evaluation deadline (default 30000)            |
| `--allowed-origin <origin>` | Accept this exact additional browser origin; repeatable        |

The CLI parses flags, renders service events, opens the browser and translates
SIGINT/SIGTERM/SIGHUP into service shutdown. Exit codes are 0 for normal
shutdown, 1 for fatal startup failure, and 2 for invalid arguments. A second
signal forces termination of a pending compile child. Repeating the command for
a running project prints its existing URL.

The [development package](../dev/README.md) owns the server, file watching,
compilation and runtime children, sessions, MCP, playground, activity and agent.
It also documents configuration, seeding, reload behavior and endpoint
contracts. For embedding, import `startDev` from `@relate/dev`.

The command does not load `.env` files. Use the application's loader when
needed:

```sh
pnpm exec dotenvx run -f .env -- pnpm relate dev
```

See the [Inspector guide](../../apps/docs/content/authoring/inspector.md) for
using the graph, agent, activity log and query playground.
