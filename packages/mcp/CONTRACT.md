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
sessions or resumability; GET/DELETE return 405. Cross-request cancellation is
not correlated. The host owns HTTP serving, TLS and host-header checks.

`connectStdio({ executor, bindGraph, input?, output? })` returns a connected MCP
server; the host/launcher chooses an authenticated actor. Stdout carries only
MCP messages; JS logs are returned in results. Close the server and host runtime
on shutdown. Stdio cancellation/server closure abort the execution signal.

## Development executor

`createDevelopmentExecutor({ timeoutMs?, maxOutputBytes? })` creates one Node
child and temporary working directory per execution. Defaults: 10,000 ms and
1,048,576 bytes. Only actor-visible routes and discovery metadata enter the
child. The child constructs the existing consumer facade and forwards the five
public graph operations over IPC. The parent keeps actor identity and
operations, checks model revision before dispatch, and never automatically
retries.

All returned query pages, records, evidence and receipts use existing public
shapes. Known read/action exceptions retain their public codes; caught read
exceptions also retain option issues. Unexpected parent errors are sanitized.

The parent captures stdout/stderr in bounded UTF-8 chunks and counts serialized
result/error bytes in the same output budget. A fixed failure diagnostic can
exceed the payload budget. A timer bounds child startup, JS and waiting for
graph operations; at most 64 graph calls may be in flight. Completion waits for
already dispatched calls unless the timeout/abort fires. Success, JS errors,
premature exit, timeout, output overflow and cancellation all terminate the
child and remove its temporary directory before execution resolves. On Unix the
parent kills the child's process group, including ordinary descendants; Windows
kills the direct child. This is not a guarantee against hostile processes
escaping.

No globals, module caches, environment mutations, timers, or temporary-directory
files survive. Each child starts without host environment variables or exec
flags. Graph changes and external side effects persist according to their own
contracts. Parent operations already dispatched cannot be cancelled by this
interface; timeout is not rollback and does not prove an action failed. Retain
idempotency keys and inspect receipts; do not blindly replay actions.

Code runs with ordinary Node privileges. It may read/write arbitrary accessible
files, spawn processes or use the network. This executor is explicitly a
**development executor, not a security sandbox**. Replace it before serving
untrusted code. IPC validation and output limits are robustness measures, not an
adversarial containment boundary.
