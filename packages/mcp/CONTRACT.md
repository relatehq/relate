# MCP contract

The package owns MCP tool registration, transport adapters, and execution IPC.
It uses `relate/consumer` and `@relate/protocol`; it does not own graph
semantics, authentication, persistence, or action transactions.

## Public interface

`GraphBinding` carries the compiler's consumer description and actor-bound
`ConsumerOperations`. `CodeExecutor.execute({ code, graph, signal? })` returns
`ExecutionResult`: success with JSON `result`, or failure with
`error: { name, message, code? }`; both contain `logs: { stream, text }[]`.

`createMcpServer({ executor, bindGraph })` registers exactly `discover` and
`execute`. Tool inputs use strict schemas. The binding callback runs per tool
invocation. Host/executor exceptions become sanitized tool failures. `discover`
returns actor-visible overview metadata and JS instructions; object and action
details remain accessible through the injected consumer's describe methods.
`execute` returns the executor's result as both structured content and JSON
text; failed execution sets `isError: true`. Domain-failed receipts remain
ordinary execution results.

`createStreamableHttpHandler({ executor, bindGraph, allowedOrigins? })` returns
a Fetch handler. The host binding callback authenticates every HTTP request and
can return a `Response` for denial/challenges. Present origins are denied unless
explicitly allowed. This is stateless Streamable HTTP with JSON responses, no
sessions or resumability; GET/DELETE return 405. Cross-request MCP cancellation
is not correlated; an aborted HTTP Request signal cancels its own execution. The
HTTP host must link client disconnects to that signal. The host owns HTTP
serving, TLS and host-header checks.

`connectStdio({ executor, bindGraph, input?, output? })` returns a connected MCP
server; the host/launcher chooses an authenticated actor. Stdout carries only
MCP messages; JS logs are returned in results. Close the server and host runtime
on shutdown. Stdio cancellation/server closure abort the execution signal.

## Development executor

`createDevelopmentExecutor({ timeoutMs?, maxOutputBytes? })` creates one Node
child and temporary working directory per execution. Defaults: 10,000 ms and
1,048,576 bytes. Only actor-visible routes and discovery metadata enter the
child. The child constructs the existing consumer facade and forwards the five
public graph operations over IPC. The parent keeps actor identity and operations
and never automatically retries. The binding is validated at startup;
ConsumerOperations owns authorization and model pinning on every dispatched
call. MCP does not re-read discovery for each operation.

All returned query pages, records, evidence and receipts use existing public
shapes. Results are JSON-encoded once in the child, carried as a string over
advanced IPC, budgeted and decoded once in the parent. Known read/action
exceptions retain their public codes; caught read exceptions also retain option
issues. Unexpected parent errors are sanitized.

The parent captures stdout/stderr in bounded UTF-8 chunks and counts serialized
result/error bytes in the same output budget. A fixed failure diagnostic can
exceed the payload budget. A timer bounds child startup, JS and waiting for
graph operations; at most 64 graph calls may be in flight. Completion waits for
already dispatched calls unless the timeout/abort fires. Success, JS errors,
premature exit, timeout, output overflow and cancellation all terminate the
child and remove its temporary directory before execution resolves. On Unix the
parent kills the child's process group, including ordinary descendants; Windows
kills the direct child. This is not a guarantee against hostile processes
escaping. Output pipes are drained for at most 250 ms after termination, then
closed, so an escaped descendant holding a pipe cannot block the result or
temporary-directory cleanup. A watchdog worker thread detects host death even
while user JavaScript blocks the main thread and kills the execution's process
group. Host crashes may leave the temporary directory behind because the host
owns its removal.

No globals, module caches, environment mutations, timers, or temporary-directory
files survive. Each child inherits only PATH and, on Windows, SystemRoot, windir
and PATHEXT. TMPDIR/TMP/TEMP point at its disposable directory. Application
secrets, NODE_OPTIONS, NODE_PATH and host exec flags are not inherited. Graph
changes and external side effects persist according to their own contracts.
Parent operations already dispatched cannot be cancelled by this interface;
timeout is not rollback and does not prove an action failed. Retain idempotency
keys and inspect receipts; do not blindly replay actions.

Code runs with ordinary Node privileges. It may read/write arbitrary accessible
files, spawn processes or use the network. This executor is explicitly a
**development executor, not a security sandbox**. Replace it before serving
untrusted code. IPC validation and output limits are robustness measures, not an
adversarial containment boundary.
