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
there is no `setup` to supply connections for its sources; the status bar shows
a neutral **No runtime** and the graph itself is unaffected. Pass `--no-runtime`
to inspect the model without starting the application at all.

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
| **No runtime**         | The config exports a bare graph whose sources need connections that only `defineApp` `setup` can supply. Not an error; export an app to run it.       |
| **Data reset**         | The runtime restarted and the previous runtime's in-memory data was discarded.                                                                        |
| **Runtime on abc1234** | The running runtime serves a different revision from the displayed model, for example while a restart is in progress or after the new runtime failed. |

The runtime restarts on every accepted change, even when the model is unchanged,
because connector and action code may have changed:

- **No store from `setup`** (or no `setup`): the runtime's own in-memory store.
  Its data is lost on every restart, and the terminal says so:
  `runtime gen 2  running  in-memory store, previous data reset`.
- **A persistent store** (for example Postgres) is used as-is. The runtime
  checks the store's model revision as soon as it starts, before any request: an
  empty store has the current revision written into it at that point, so
  starting `relate dev` against a fresh database installs the model. If the
  store already holds a different model revision, the runtime reports
  `runtime.store-revision-mismatch` and stays stopped. It never resets or
  migrates your data to recover. Use `--no-runtime` to inspect without touching
  the store.

Resetting the in-memory store does not undo anything a connector or action
already did in an external system. Receipts are lost with it, so reusing an
idempotency key after a restart may perform an action again.

The runtime process does not receive `ANTHROPIC_API_KEY` (the
[built-in agent](#ask-the-built-in-agent)'s key) from your environment; every
other variable is inherited.

**Principal selector.** When the graph declares
[development principals](./access-control.md#development-principals), the status
bar shows an **as** selector listing them; the first declared one is the
default. The choice belongs to your browser tab and is remembered per graph.
Without declared principals the status bar shows **no principals**.

## Connect Claude or Another MCP Client

`relate dev` serves your running graph to AI agents over
[MCP](https://modelcontextprotocol.io) at `/mcp`, with two tools: `discover`
(what this principal can see) and `execute` (run JavaScript against the graph).
The terminal prints the endpoint and a ready-to-paste command:

```text
  MCP        http://127.0.0.1:4318/mcp
             claude mcp add --transport http relate "http://127.0.0.1:4318/mcp" --header "Authorization: Bearer <token>"
             Append ?as=<principal> to act as another development principal
```

Paste that line to add the graph to Claude Code. The agent then acts as the
default development principal (the first one declared). To test what another
principal can see and do, add `?as=<name>` to the URL, for example
`http://127.0.0.1:4318/mcp?as=auditor`, as a second server entry. The agent
reads and acts through the same policies as any other caller, so a principal
without the `reader` role sees no customers at all.

- **Token:** created the first time `relate dev` runs in a project and kept in
  `.relate/dev/mcp-token`, readable only by you, so a saved client entry keeps
  working when you restart `relate dev`. That directory gets its own
  `.gitignore`, so the token is never committed. Run
  `relate dev --rotate-mcp-token` to replace it, for example after sharing a
  terminal recording; saved entries then need the new line. A second
  `relate dev` invocation for the same project prints the line again. The
  inspector's browser session does not grant MCP access.
- **Local clients only:** the endpoint listens on `127.0.0.1` and refuses
  requests sent from a web page. Any local client that supports Streamable HTTP
  and a custom `Authorization` header can connect the same way. Clients that run
  in the cloud, such as ChatGPT, cannot reach it: they need a public tunnel,
  which `--allowed-origin` does not cover today. Tunnel support is planned.
- **Unknown principals:** `?as=` with a name the graph does not declare is
  rejected with the declared names. A graph without declared principals cannot
  be served over MCP.
- **No runtime:** when the runtime cannot serve the call, each tool call returns
  a `binding-unavailable` error at once with the reason and whether a retry can
  help, instead of waiting. For example, while it restarts:
  `{ "code": "binding-unavailable", "message": "The runtime is restarting; retry shortly", "retryable": true }`.
  A failed runtime, `--no-runtime`, or a principal you just added that the
  running runtime predates each say so.
- **Restarts:** each call runs against the runtime that was active when it
  arrived. If you save a change while an `execute` call is still running, its
  later graph reads and actions fail with `runtime-retired`; they are never
  silently sent to the new runtime. An action cut off mid-flight reports
  `uncertain`, because whether it completed is unknown.

`execute` runs the agent's JavaScript in a fresh Node process on your machine.
It is a development tool, not a sandbox: connect only agents you trust with your
development data.

## Ask the Built-in Agent

The chat button at the right of the status bar opens the **Agent** panel. Ask a
question about your graph, or ask it to do something, and the agent answers as
the principal selected in the **as** selector, through the same `/mcp` endpoint
and policies an external client uses:

```text
Add a note saying "Call the customer", then tell me how many notes exist.

  discover  succeeded                                            Activity →
  execute   succeeded                                            Activity →
    return await graph.actions.addNote({ input: { body: 'Call the customer' }, idempotencyKey: 'alice-note-1' });
    [addNote]
  execute   succeeded                                            Activity →
    const page = await graph.objects.Note.query({ limit: 100 }); …
    [Note]

I added the note. Alice can see 1 note; the count only covers notes alice may read.
```

Each tool call shows the code it ran and the objects it touched. **Activity →**
opens that call in the activity log, and hovering a call highlights its objects
on the graph.

**Setup.** The agent runs inside `relate dev`, never in the browser, and uses
the `claude-opus-5-5` model with your own Anthropic API key. Put the key in the
project's `.env` and start `relate dev` with the project's loader, because
`relate dev` loads no `.env` file itself:

```sh
# .env
ANTHROPIC_API_KEY=sk-ant-...

pnpm exec dotenvx run -f .env -- pnpm relate dev
```

Without a key the panel explains this setup, the terminal prints
`Agent      off: no ANTHROPIC_API_KEY`, and everything else in the inspector
works as before. The key is read only by the `relate dev` process: your
application code (the compile and runtime processes), the code the agent runs in
`execute`, and the browser never receive it.

**One conversation per principal.** Switching the **as** selector shows that
principal's own conversation; the model never sees records it read as someone
else. A question that is still running keeps the principal it started with, even
if you switch while it works. Conversations are kept in memory and are cleared
when `relate dev` stops.

**Cancel.** While the agent works, **Cancel** stops the response and any tool
call still running. A cancelled call is reported to the agent as cancelled with
an unknown outcome and is never retried: an action may or may not have run, so
check the data before asking again.

**Restarts.** If you save a change while the agent works, its next tool call can
return `binding-unavailable` with `retryable: true`. The agent sees that result
and decides what to do; `relate dev` never repeats a call for it.

## The Activity Log

The **Activity** page (the clock icon in the left rail) shows every `discover`
and `execute` call as it happens: who called (**inspector agent** for the
built-in agent, **external client** otherwise), as which principal, the code an
agent ran, its console output and result, and each graph read and action that
code made, with filters, record counts, receipt states and errors. While an
operation runs, the objects it touches are highlighted on the graph.

```text
execute  as alice  external client  3 operations           runtime a5fb52bc  51 ms
  await graph.actions.addCustomer({ input: { name: 'Acme' }, idempotencyKey: 'acme-1' });
  const page = await graph.objects.Customer.query({ limit: 5, where: { name: 'Acme' } });
  invoke  addCustomer  input {"name":"Acme"} · key acme-1    receipt succeeded
  query   Customer     where {"name":"Acme"} · limit 5        1 record
```

The log keeps the most recent 200 calls in the `relate dev` process and is
cleared when it stops. It survives runtime restarts; calls made against an
earlier runtime are marked **retired**, because that runtime's data and code may
differ from the current one. Record values are never stored: the log keeps
record IDs, counts and short previews of filters, action inputs and results.

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
- **MCP client gets 401:** the project's token was rotated with
  `--rotate-mcp-token`, or `.relate/dev/mcp-token` was deleted; copy the new
  `claude mcp add` line from the terminal.
- **Environment variables:** the command inherits your shell's environment and
  does not load `.env` files. If your definitions need them, use your project's
  environment loader. In this checkout, for example:

  ```sh
  pnpm exec dotenvx run -f .env -- pnpm relate dev --config ./relate.config.ts --open
  ```

For all flags and process behavior, see the
[CLI reference](../../../../packages/cli/README.md). For authoring the model,
see [Graph Modeling](./graph.md).
