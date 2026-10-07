# @relate/cli

Development and operational commands using programmatic APIs.

Scaffold only. No implementation, executable, or public exports exist yet.
Workspace dependencies record the intended package relationships.

The [inspector foundation specification](../../apps/inspector/SPEC.md) proposes
`relate dev`: a stable Hono supervisor serves the packaged React/Vite inspector
and watches an explicit configuration entry, while a child process compiles its
graph. The initial scope displays one React Flow/ELK model graph, updated over
SSE. It does not start the surrounding application's server or runtime
resources.
