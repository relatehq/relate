# create-relate

> Development baseline (`0.0.0-dev.0`), for discussion and contribution only.
> Not ready for application use. APIs and behavior are incomplete and may change
> without notice.

> [!WARNING]
>
> Scaffold only. No implementation, executable or public exports exist yet.

Project generator and deployment-target templates.

## Planned responsibility

The `npm create relate` / `pnpm create relate` entry point. It scaffolds a new
application that authors a graph with `relate`, composes it with `@relate/node`,
and chooses a storage and deployment target such as a local Postgres database.
Generated projects use only public package APIs; the generator owns templates
and prompts, not behavior.

## How it will fit

- No workspace dependencies: it writes files that depend on the published
  packages rather than importing them.
- Sixth and last step in the implementation sequence, together with
  `@relate/cli`, once the APIs it would generate code for are stable.

Templates and prompts are not designed yet. The
[hello world example](../../examples/hello-world/README.md) is the current
smallest working project and the likely starting shape.
