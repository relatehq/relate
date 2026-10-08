# Running the Inspector

The inspector displays your graph's object types, properties, and relationships
in a browser. Select a node or relationship to inspect its details. It updates
when you save changes to the definitions.

This is a view of the model, not a browser for individual customer or invoice
records. The inspector compiles your definitions without starting the runtime,
database, application server, or connectors.

## Open an Example Graph

From the root of a Relate checkout, install dependencies and build the packages:

```sh
pnpm install
pnpm build
```

Then open the customer and invoice example:

```sh
pnpm relate dev --config dev/fixtures/customer-graph/invoice-read/model.ts --open
```

You should see **Customer** and **Invoice**, connected by the
**CustomerInvoices** relationship. The terminal reports a ready model with 2
objects, 2 sources, and 1 relationship. No database or credentials are needed
for this example.

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
`setup`, which the inspector never calls. Do not point the inspector at an
application entry that starts servers or runs queries at the top level.

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
  compilation updates the graph; invalid code shows diagnostics and keeps the
  last good model visible until you fix it.
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
