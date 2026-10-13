# Running the Inspector

The inspector displays your graph's object types, properties, and relationships
in a browser. Select a node or relationship to inspect its details. It updates
when you save changes to the definitions.

This is a view of the model, not a browser for individual customer or invoice
records. Alongside the graph, `relate dev` starts your application's runtime in
a separate process (see
[Development Principals and the Runtime](#development-principals-and-the-runtime)).
Displaying the graph never depends on that runtime: a runtime that fails to
start leaves the graph and its diagnostics visible.

## Open an Example Graph

From the root of a Relate checkout, install dependencies and build the packages:

```sh
pnpm install
pnpm build
```

Then open the customer and invoice example:

```sh
pnpm relate dev --config examples/02-customer-workspace/relate.config.ts --open
```

You should see **Customer**, **Invoice**, and **Account review**, connected by
the **CustomerInvoices** and **CustomerReviews** relationships. The model has 3
objects, 2 sources, and 2 relationships. No database or credentials are needed
to inspect these definitions. This config exports the graph without an app, so
there are no connections for its sources and the status bar shows **Runtime
failed** with a `runtime.setup-failed` diagnostic; the graph itself is
unaffected.

`--open` opens the browser. You can also open the complete Inspector URL printed
in the terminal, including its `#token=…` fragment. That link establishes the
browser session; opening the bare address in a fresh browser does not.

Keep the command running while you inspect or edit the graph. Press **Ctrl+C**
to stop it.

## Open Your Own Graph

Create a `relate.config.ts` in your project directory that exports your graph:

```ts
// relate.config.ts
export { graph as default } from './src/graph.js';
```

Then run from that directory, with the Relate CLI available:

```sh
pnpm relate dev --open
```

The default lookup checks `relate.config.ts`, `.mts`, `.js`, and `.mjs` in the
working directory. To select an entry elsewhere, pass its path explicitly:

```sh
pnpm relate dev --config ./packages/business/relate.config.ts --open
```

The entry can default-export either a `defineGraph(...)` result or a
`defineApp(...)` result. Named exports called `graph` or `app` also work, which
is why the example above can load `model.ts` directly. For a differently named
export, use a config file to re-export it as default.

The inspector evaluates the entry and its imports. Keep them safe to import: put
connector initialization and credential-dependent work inside your app's
`setup`. Graph compilation never calls `setup`; only the separate runtime
process does. Do not point the inspector at an application entry that starts
servers or runs queries at the top level.

## Development Principals and the Runtime

For every successfully compiled change, `relate dev` starts a fresh runtime
process for your app: it calls `setup` and starts the runtime exactly as your
application would. That process has no HTTP listener of its own.

The status bar shows its state:

| Indicator              | Meaning                                                                                                                                               |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Runtime starting**   | The first runtime is running `setup`.                                                                                                                 |
| **Runtime restarting** | A newer change was accepted; the previous runtime is draining and a new one is starting.                                                              |
| **Runtime running**    | Ready. Hover for its revision and store.                                                                                                              |
| **Runtime failed**     | `setup` threw, timed out, or the store rejected the model. Hover for the diagnostic; the terminal prints it too. The next accepted change retries.    |
| **Data reset**         | The runtime restarted and the previous runtime's in-memory data was discarded.                                                                        |
| **Runtime on abc1234** | The running runtime serves a different revision from the displayed model, for example while a restart is in progress or after the new runtime failed. |

The runtime restarts on every accepted change, even when the model is unchanged,
because connector and action code may have changed:

- **No store from `setup`** (or no `setup`): the runtime's own in-memory store.
  Its data is lost on every restart, and the terminal says so:
  `runtime gen 2  running  in-memory store, previous data reset`.
- **A persistent store** (for example Postgres) is used as-is. If it already
  holds a different model revision, the runtime reports
  `runtime.store-revision-mismatch` and stays stopped. It never resets or
  migrates your data to recover.

Resetting the in-memory store does not undo anything a connector or action
already did in an external system. Receipts are lost with it, so reusing an
idempotency key after a restart may perform an action again.

The runtime process does not receive `ANTHROPIC_API_KEY` from your environment;
every other variable is inherited.

**Principal selector.** When the graph declares
[development principals](./access-control.md#development-principals), the status
bar shows an **as** selector listing them; the first declared one is the
default. The choice belongs to your browser tab and is remembered per graph.
Without declared principals the status bar shows **no principals**.

## Switch Between Graphs

Stop the command with **Ctrl+C**, then run it again with the other graph's
`--config` path. Graph selection happens through the command, not a browser
graph picker.

To inspect two graphs at once, put their entry files in separate directories and
run one command per terminal:

```sh
# Terminal 1
pnpm relate dev --config ./projects/sales/relate.config.ts --port 4318 --open
```

```sh
# Terminal 2
pnpm relate dev --config ./projects/support/relate.config.ts --port 4319 --open
```

There is one inspector server per project, identified by the directory
containing the entry file. Two config files in the same directory share that
identity: a second invocation reuses the running server instead of loading a
second graph, even if you specify another port.

Without `--port`, the command picks the first free port from **4318–4327** on
`127.0.0.1`. An explicit port must be available.

## Editing and Troubleshooting

- **Changes on save:** imported definition files are watched. Successful
  compilation updates the graph and restarts the runtime; invalid code shows
  diagnostics and keeps the last good model and runtime until you fix it.
- **Runtime failed:** read the `runtime.*` diagnostic in the terminal. A
  graph-only config has no `setup`, so source-backed objects have no
  connections; export `defineApp({ graph, setup })` to run it.
- **No config found:** create `relate.config.ts` or pass `--config` explicitly.
  The repository root does not ship a default config.
- **Missing inspector assets:** run `pnpm build` from the repository root.
  `relate dev` serves the prebuilt inspector client.
- **Environment variables:** the command inherits your shell's environment and
  does not load `.env` files. If your definitions need them, use your project's
  environment loader. In this checkout, for example:

  ```sh
  pnpm exec dotenvx run -f .env -- pnpm relate dev --config ./relate.config.ts --open
  ```

For all flags and process behavior, see the
[CLI reference](../../../../packages/cli/README.md). For authoring the model,
see [Graph Modeling](./graph.md).
