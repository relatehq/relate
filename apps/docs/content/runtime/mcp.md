# MCP: Discover and Execute

`@relate/mcp` lets an agent inspect a graph and run JavaScript against its
actor-bound consumer. Both stdio and Streamable HTTP expose exactly two tools:

| Tool       | Input             | Response                                                 |
| ---------- | ----------------- | -------------------------------------------------------- |
| `discover` | `{}`              | Actor-visible graph overview and JavaScript instructions |
| `execute`  | `{ "code": "…" }` | JSON result, captured stdout/stderr, or an error         |

The host supplies authentication, a graph binding, and a `CodeExecutor`. The
included Node subprocess executor is for trusted local development. It is **not
a security sandbox**: code can use Node APIs, the filesystem and network with
the host OS user's permissions. Use a suitably isolated execution service before
accepting untrusted code.

## Execution flow

```mermaid
sequenceDiagram
  participant Agent as MCP client
  participant Host as MCP host
  participant Child as Node child
  participant Graph as Actor operations
  Agent->>Host: discover {}
  Note over Host: Authenticate caller
  Host->>Graph: Read visible metadata
  Graph-->>Host: Overview and SDK guide
  Host-->>Agent: Metadata and JS instructions
  Agent->>Host: execute { code }
  Note over Host: Authenticate and bind actor
  Host->>Child: Start fresh: code and metadata
  Note over Child: Create consumer facade
  Child->>Host: Query over IPC
  Host->>Graph: operations.query(...)
  Graph-->>Host: Authorized page
  Host-->>Child: Page result
  Child->>Host: Action over IPC
  Host->>Graph: operations.invoke(...)
  Graph-->>Host: Receipt
  Host-->>Child: Receipt
  Child-->>Host: Result and captured output
  Note over Host,Child: Kill child; remove temporary directory
  Host-->>Agent: Result, logs, or error
```

Discovery reads metadata without launching a subprocess. On execution, the
parent keeps the actor-bound operations; only visible routing and discovery
metadata go to the child. The child builds the existing `relate/consumer` facade
and forwards reads and actions over IPC. The runtime continues to authorize each
operation. Discovery does not grant permission to read a particular record or
invoke an action.

Stdout and stderr travel through separate captured pipes. The parent enforces
time and output limits, kills the child on completion or failure, and removes
its temporary working directory before returning. CPU loops, errors, and
cancellation follow the same cleanup path. On Unix it also terminates the
child's process group; this is development cleanup, not containment of hostile
descendants. After termination, pipe draining is capped at 250 ms: even an
escaped grandchild holding stdout open cannot prevent a result and directory
cleanup. A separate watchdog thread detects host death and kills the execution
even when its main JavaScript thread is stuck in a CPU loop. An abrupt host
crash can leave its temporary directory behind.

## Discovery → query → action

Call `discover` with `{}`. Its `graph` contains visible API names, connected
traversals, action summaries and SDK guidance; `instructions` explains how to
use them in JavaScript. Then call `execute` with a function body:

```js
// execute({ code: "..." }) injects graph; no imports or wrapper are needed.
const detail = graph.objects.Note.describe();
const page = await graph.objects.Note.query({ limit: 10 });
console.log('Read', page.data.length, 'notes');
return { detail, page };
```

An explicit `return` supplies the result. `await query()` returns one page;
`for await` iterates records across pages. Object and action details are
available synchronously through `.describe()` inside the execution.

```js
const action = graph.actions.addNote.describe();
console.log(action.input);
return await graph.actions.addNote({
  input: { text: 'Follow up on the notes I just read.' },
  idempotencyKey: 'follow-up-001',
});
```

The example's action creates a graph-owned note and returns its receipt. A
successful JavaScript execution can still return a domain-failed action receipt;
inspect `result.state`. Execution failures set the MCP tool result's `isError`.

```json
{
  "status": "succeeded",
  "result": {
    "state": "succeeded",
    "invocationId": "…",
    "output": { "id": "…" }
  },
  "logs": []
}
```

`undefined` returns become `null`. Other results use JSON serialization: cyclic
values and BigInt fail. Logs are ordered pipe chunks, not individual console
calls; stdout and stderr ordering relative to each other is not guaranteed.

## Bind the caller in your host

The host combines compiler-produced routing with operations bound to an
authenticated actor:

```ts
import { compile } from 'relate/compiler';
import {
  createDevelopmentExecutor,
  createStreamableHttpHandler,
} from '@relate/mcp';

const description = compile(graph).consumer;
const executor = createDevelopmentExecutor({
  timeoutMs: 10_000,
  maxOutputBytes: 1024 * 1024,
});

// graph and runtime are your existing model and composed Relate runtime.
// authenticate is supplied by your application.
const handleMcp = createStreamableHttpHandler({
  executor,
  allowedOrigins: ['https://app.example.com'],
  async bindGraph(request) {
    const actor = await authenticate(request);
    if (!actor) return new Response('Unauthorized', { status: 401 });
    return { description, operations: runtime.operations(actor) };
  },
});

// Mount handleMcp(request: Request): Promise<Response> at /mcp.
```

The handler authenticates each request, including initialization. It uses
stateless Streamable HTTP with JSON responses and no persistent MCP sessions.
GET and DELETE return 405; unsolicited server event streams and resumability are
not offered. Present `Origin` headers must match `allowedOrigins`; they are
denied by default. Your web host owns TLS, routing, credential validation,
authorization challenges and host-header validation.

For stdio, the launcher or host authenticates the local caller and supplies its
binding. The binding callback runs for every tool invocation:

```ts
import { connectStdio, createDevelopmentExecutor } from '@relate/mcp';

const server = await connectStdio({
  executor: createDevelopmentExecutor(),
  bindGraph: () => ({ description, operations: runtime.operations(actor) }),
});
// await server.close() during host shutdown; close the runtime separately.
```

The stdio server reserves stdout for MCP messages. Execution logs are returned
inside the tool result. Keep host logging on stderr.

## Replace execution without changing the tools

```ts
import type { CodeExecutor, ExecutionResult, GraphBinding } from '@relate/mcp';

interface ExecutorContract {
  execute(request: {
    code: string;
    graph: GraphBinding;
    signal?: AbortSignal;
  }): Promise<ExecutionResult>;
}

const executor: CodeExecutor = yourExecutionService;
```

`GraphBinding.description` is the compiler's consumer routing metadata;
`GraphBinding.operations` is an actor-bound `ConsumerOperations`. Operations
remain in the host and must retain their authorization and model-compatibility
checks when bridged to another execution service. The built-in executor
validates binding compatibility before startup. ConsumerOperations owns model
pinning and authorization for every operation; MCP does not re-read discovery on
each call or retry failed operations.

`ExecutionResult` is either `{ status: 'succeeded', result, logs }` or
`{ status: 'failed', error: { name, message, code? }, logs }`. The tools do not
depend on the execution service's process or hosting model.

## Limits and cleanup

The development executor defaults to 10 seconds and 1 MiB of combined captured
output and serialized result/error data. Fixed failure diagnostics may add a
small amount beyond that payload budget. It permits at most 64 simultaneous
graph calls. Failures include `timeout`, `output-limit`, `aborted`, `process`,
`binding`, and `operation-limit`; JavaScript errors preserve their name and
message. Public `ReadError` and `ActionError` codes survive IPC; code catching a
`ReadError` also receives its option issues. Unexpected parent errors are
sanitized before reaching the child.

Each call starts a fresh process with a fresh temporary directory. The child
inherits only PATH and, on Windows, SystemRoot, windir and PATHEXT; its
TMPDIR/TMP/TEMP point at that directory. Host application secrets and Node
loader flags are not inherited. Globals, module caches, timers, and files in
that directory do not survive. Files written elsewhere, network effects, and
graph mutations are outside this reset guarantee.

A timeout or abort stops the JavaScript child and prevents further dispatch.
Already-started graph operations can continue: `ConsumerOperations` has no
cancellation parameter. Cleanup does not roll back committed actions. Await all
graph calls and retain the original idempotency key if an outcome is uncertain;
use [action receipts](./actions.md) to inspect completed work. HTTP is
stateless, so cross-request MCP cancellation notifications are not correlated.
An aborted HTTP Request signal cancels its own execution; the HTTP host must
wire client disconnects to that signal. The executor timeout also bounds
execution. Stdio cancellation and server closure signal active executions.

## Run the example

From the repository root:

```sh
pnpm install
pnpm build
pnpm --filter @relate/mcp example
```

The
[runnable example](../../../../packages/mcp/examples/discovery-query-action.ts)
uses a real in-memory graph and an MCP client to discover, query, then create a
note through Streamable HTTP. It uses an in-process Fetch adapter and opens no
port. To connect a stdio MCP client to the same example:

```sh
node --import tsx packages/mcp/examples/discovery-query-action.ts --stdio
```

See [graph discovery](./discovery.md), [reading data](./reading-data.md), and
the [package contract](../../../../packages/mcp/CONTRACT.md) for the underlying
APIs.
