# Explainer follow-up: incomplete, no promotion

11 October 2026. New PRs, if justified, must target main.

Five attempts (three controls, one collections arm, one diagnostics arm) stopped
with `SSLError: SSL: UNEXPECTED_EOF_WHILE_READING` contacting the model
provider. Only the first control received one model turn. No episode has a
scored task result. The same intermittent failure reproduces outside the harness
using unauthenticated Python requests and curl. No automatic retries or model
switches were introduced. Known recorded model cost: $0.000192; failed requests
have no returned usage, so this is not proof of total provider billing.

Sanitized attempt records:
[evidence/explainer-attempts.json](evidence/explainer-attempts.json). Protected
inputs, trajectories and frozen harness sources remain under each checkout's
ignored `dev/research/appworld/.local/runs/` directory.

## Local prototypes

- `test/explainer-error-diagnostics`, commit `ff2a9e5`: authorized structured
  action input issues and accepted read operators in bounded messages. Focused
  tests: 11 passed. TypeScript test typecheck and changed-file lint pass.
- `test/explainer-collections`, prototype `1a6411b`, formatting `598976c`:
  `page()` and `records()` use the existing lazy pagination engine.
  Consumer/pagination tests: 38 passed. TypeScript test typecheck and
  changed-file lint pass. The attempted arm used `1a6411b`; subsequent changes
  are test whitespace.
- `test/explainer-sdk-experiments`, baseline `320bbe9`: main `2cf7f92` plus PR
  24 operation identity, with unchanged research support from PR 14 `59fb67c`.
- `test/explainer-action-outcomes` is prepared at the baseline but has no new
  implementation or experiment yet.

No prototype is a validated SDK improvement. Full checks, public documentation,
reference-input diagnostics tests, broader correctness gates, confirmation and
holdout remain outstanding. No PR was opened and no SDK code was added to PR 14.
PR 24 remains open and is an explicit common prerequisite, not a new
improvement.

## Remaining work

Resume only after stable provider connectivity. Keep failed attempts; create new
run names and compare contemporary complete controls and candidates. Implement
and independently evaluate action outcome discovery, local datetime semantics,
relationship discovery and traversal filters, and acquisition coverage,
including the plain-TypeScript snapshot control. These directions have been
inspected but not tested in this follow-up. Follow the frozen promotion criteria
in [EXPLAINER-PLAN.md](EXPLAINER-PLAN.md). Do not treat missing scores as
failures or report local unit-test success as agent task uplift.

The database container was started successfully. The first two new worktrees
were created with `--skip-db` because it was initially stopped; later worktrees
have their own helper-created databases. Preserve unrelated dirty
primary-checkout work and do not publish the prerequisite cherry-pick as a new
SDK proposal.
