# Specifications

Design records that span packages. Each file is named `YYYY-MM-DD-<topic>.md`
after the date its design was agreed, so the folder lists them in order, and its
title starts with the same date.

Specs record agreed designs and their status; they are not product documentation
and are not rendered by the docs site. Exported package source, package
contracts (`packages/*/CONTRACT.md`) and executable tests remain the source of
truth for implemented behavior.

Once implemented, specs are historical references: they explain the decisions,
constraints and tradeoffs at the time, not permanent rules for the product.
Revisit those decisions as the product evolves and assess new proposals against
current needs and evidence. A feature deferred or excluded from an earlier spec
is not a reason to defer or exclude it in a current discussion; any such
decision needs a current rationale.

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
- [2026-10-23: Media agency agent benchmark](./2026-10-23-media-agency-benchmark.md)
  — systems, arms, tiers, action approach and currency conversion agreed;
  harness and task contracts proposed; not implemented. Requires the two feature
  specs below and their prerequisites before the graph is frozen.
- [2026-10-28: Action adoption](./2026-10-28-action-adoption.md) — handlers
  adopt platform records they create, committing with the action; API agreed,
  storage strategy proposed; not implemented.
- [2026-10-28: Reference datasets](./2026-10-28-reference-datasets.md) — keyed
  datasets joined by full key (for example exchange rates); direction agreed,
  grammar and result contracts proposed; not implemented.
- [2026-10-28: Arithmetic inside aggregate arguments](./2026-10-28-row-arithmetic.md)
  — proposed prerequisite for reference-dataset currency conversion; checked
  per-row arithmetic and failure isolation; not implemented.
- [2026-10-28: Analytical calendar dates](./2026-10-28-analytical-dates.md) —
  proposed calendar-date type and connector contracts; ISO text remains the
  explicit benchmark fallback; not implemented.
