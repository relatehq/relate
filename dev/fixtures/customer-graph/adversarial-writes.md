# Adversarial native-write acceptance fixture

Status: **declaration-only acceptance**. These files are typechecked by
`pnpm typecheck`; they do not run an executor or prove enforcement.

[`validation/adversarial-writes.ts`](./validation/adversarial-writes.ts)
declares one fixture-only action and its deliberately unsafe async
implementation. It does no reads, accepts the supplied author unchanged, creates
a review, and creates a task using the supplied invoice and optional existing
review. Its fixture graph reuses the application's policies unchanged. The
ordinary application does not register this action.

## Where the application declares rejection rules

In [`source/graph.ts`](./source/graph.ts):

- `policies.AccountReview.create` requires the account-manager role, a customer
  whose portfolio matches the caller's claim, and `author === access.actor.id`.
- `policies.Task.create` requires the same role and customer portfolio match.
- `policies.Task.integrity` independently requires `task.customer` to equal both
  `task.invoice.customer` and `task.review.customer`.

The action's `creates` list supplies capabilities, and its execution gate
permits invocation. Neither replaces object create permission or relationship
integrity. Skipping a customer lookup is not itself an error: a permitted write
must still succeed, while an unauthorized write must fail without relying on
that lookup.

## Required outcomes

[`validation/adversarial-write-scenario.ts`](./validation/adversarial-write-scenario.ts)
uses Ana, an account manager assigned to North. Northwind and Harbour Design are
both in North; Southbank is in South. Each case opens fresh storage, adopts the
source records, and creates an existing Harbour review through the ordinary
authorized action. Reads establish that Ana can see both North customers, their
invoices and the Harbour review.

| Case                              | Attempt                                                               | Expected outcome and owning rule                                                                           |
| --------------------------------- | --------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| Permitted without lookup          | Northwind review by Ana, Northwind invoice, new review linked to task | Success; both rows commit, including resolution of the new review in the same transaction                  |
| Outside portfolio without lookup  | Southbank review by Ana                                               | Rejection by `AccountReview.create` customer portfolio condition                                           |
| Another author                    | Northwind review attributed to Sara                                   | Rejection by `AccountReview.create` author condition                                                       |
| Cross-portfolio invoice           | Northwind task linked to Southbank invoice                            | Rejection under task/customer–invoice integrity; hidden or unavailable evidence must never allow the write |
| Readable other customer's invoice | Northwind task linked to Harbour invoice                              | Rejection by task/customer–invoice integrity even though both records are readable                         |
| Readable other customer's review  | Northwind task with Northwind invoice and Harbour review              | Rejection by task/customer–review integrity even though every reference is readable                        |

Every rejection must leave committed reviews and tasks exactly as they were
before the invocation, preserving the seed review and rolling back any newly
staged review. The observer reads all committed rows through trusted storage
instrumentation, not policy-filtered consumer queries that could hide an
unauthorized commit. Public failures contain a sanitized runtime code and no
hidden evidence. Exact rejection-code mapping remains open; internal faults or
unsupported execution do not count as passing rejections.

## Execution boundary

The scenario takes a future test-driver interface for fresh graph installation,
awaiting completed receipts, and inspecting committed rows. No driver, fake
executor, new policy API or production runtime implementation is added here.
Once native execution exists, connect this scenario to real memory and Postgres
execution paths. The existing
[`reference-write-scenario.ts`](./validation/reference-write-scenario.ts)
separately covers wrong-type and missing references and write-time checks using
IDs supplied through scalar inputs.

Trusted evidence resolution, evidence freshness for integrity, validation timing
and transaction isolation remain executor decisions. Immediate rejection and
final-state validation must both satisfy these final outcomes. Assertions here
do not establish trace redaction; that needs instrumentation when traces exist.
