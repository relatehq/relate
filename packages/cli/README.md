# @relate/cli

> [!WARNING]
>
> Scaffold only. No implementation, executable or public exports exist yet.
> Workspace dependencies record the intended package relationships.

Development and operational commands using programmatic APIs.

## Planned responsibility

A `relate` command line that wraps APIs which already work in the packages below
it, rather than owning behavior of its own:

- Development: the
  [inspector foundation specification](../../apps/inspector/SPEC.md) proposes
  `relate dev`. A stable Hono supervisor serves the packaged React/Vite
  inspector and watches an explicit configuration entry, while a child process
  compiles the graph with `relate/compiler` and pushes the model over SSE. The
  initial scope displays one React Flow/ELK model graph. It does not start the
  surrounding application's server or runtime resources.
- Operations: later commands around storage, such as running `@relate/postgres`
  migrations, once those APIs are stable.

Local processes, file watching and the filesystem are CLI responsibilities; the
model, compiler and runtime must keep working without it.

## How it will fit

- Depends on `relate`, `@relate/node`, `@relate/runtime` and `@relate/postgres`.
- Sixth and last step in the implementation sequence, together with
  `create-relate`: a polished workflow around APIs that already work.

Command names and flags beyond `relate dev` are not fixed.
