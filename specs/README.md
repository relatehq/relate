# Specifications

Design records that span packages. Each file is named `YYYY-MM-DD-<topic>.md`
after the date its design was agreed, so the folder lists them in order, and its
title starts with the same date.

Specs record agreed designs and their status; they are not product documentation
and are not rendered by the docs site. Exported package source, package
contracts (`packages/*/CONTRACT.md`) and executable tests remain the source of
truth for implemented behavior.

Write a spec only for a large feature that takes multiple days of thinking and
planning. Most features do not need one: agree their design in conversation or
in the pull request.

- [2026-10-07: Inspector architecture and design record](./2026-10-07-inspector.md)
- [2026-10-13: Runtime activity backbone](./2026-10-13-activity.md)
- [2026-10-18: Analytical datasets and computed fields](./2026-10-18-analytical-properties.md)
  — direction, authoring API, backends and computed filter/order agreed; revised
  2026-10-21 with spike findings and architecture review (preparation/execution,
  dependency revalidation, connector contracts, ownership and work budgets);
  includes a reading guide and execution diagrams. Detailed contracts remain
  proposed; not implemented.
