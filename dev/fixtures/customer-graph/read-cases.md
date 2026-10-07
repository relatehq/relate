# Runtime read acceptance cases

Status: **current async authoring direction, 2026-10-06**. These are behavioral
requirements, not passing runtime tests. Upfront required-read declarations have
been removed. Reads happen through authorized runtime object operations as the
implementation executes.

Consumers and action implementations share `get`, `query` and `traverse`.
`query()` and `query({ select, limit, cursor })` enumerate without a filter;
`where` adds equality filters. `await` yields one page; `for await` yields
records across pages. Both surfaces must return the same authorized results and
field evidence for the same context and data. Action-native reads add visibility
of the invocation's earlier native writes.

Traversal uses the shared relationship registry: to-many returns an awaitable,
async-iterable handle and to-one returns an `ok`/`not-found` object result, with
selection typed against the target. These rules apply inside actions as well as
to consumers. Native queries and traversals must see earlier authorized native
writes, including new relationships established by those writes. Source reads
have no implied native-transaction snapshot. See
[shared read enforcement](./authorization-cases.md#shared-read-enforcement) for
filtering and pagination authorization requirements.

| Case                                                            | Required outcome                                                                                                                                                 |
| --------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Active customer with one open and one paid invoice              | Execute a query with customer/status filters and create one task. Do not load all invoices to filter in JavaScript.                                              |
| Customer is inactive                                            | Reject before issuing the invoice query or any native writes.                                                                                                    |
| Customer status is missing, denied or unavailable               | Reject explicitly; missing is not silently treated as inactive.                                                                                                  |
| Invoice review starts with only an invoice ID                   | Read the invoice's customer reference, then use that returned ID for a customer lookup.                                                                          |
| The invoice reference or customer name is missing/hidden        | Reject without leaking hidden identity or values.                                                                                                                |
| Query returns multiple pages, including an empty non-final page | Continue until exhaustion; empty does not mean complete.                                                                                                         |
| Later page fails after native creations                         | Roll back the native review/tasks; no successful receipt. Source observations may have separate retention semantics.                                             |
| Query cannot evaluate required filter evidence                  | Reject or explicitly report incomplete evidence under a future contract; never silently omit unknown matches and claim success. Current example needs rejection. |
| Query finds no open invoices                                    | Create a review with no tasks, as the implementation explicitly specifies.                                                                                       |
| Exactly 1,000 matching invoices                                 | Permit this example if enumeration is exhausted.                                                                                                                 |
| More than 1,000 matching invoices                               | Throw and roll back all native business writes; never silently split or truncate.                                                                                |
| Provider has an invoice not adopted into the graph              | Do not claim provider-wide coverage. Sync coverage remains a separate contract.                                                                                  |
| Implementation reads a just-created native review               | Its own transaction sees it, subject to authorization.                                                                                                           |
| Source state changes during the invocation                      | No cross-source snapshot or source lock is implied by the native transaction.                                                                                    |

Object reads keep the existing best-available evidence model. The examples use
the implemented
[`assertFields`](../../../packages/relate/CONTRACT.md#require-values-after-a-read)
helper from `relate` to check selected optional fields before using them. It
checks the actual result, throws `ReadError('incomplete')` for missing required
values, and narrows only the checked fields. Valid `null` and stale values pass;
business rules such as a non-null manager or an active customer remain explicit
checks. The surrounding typed object/action API remains a declaration-only
fixture.

Strict freshness, filter evidence, snapshot coverage and query budgets need
concrete operation-level contracts; none is inferred from a mandatory
preparation phase.

Tracing records operations performed on the actual path. It does not reveal the
inactive branch's unexecuted invoice query or all possible failure paths by
statically inspecting TypeScript.

## Deleted references: implemented read behavior

A Task created while an Invoice existed survives a subsequently confirmed
billing deletion. When Task's customer-based policy still permits the read,
`Task.get(taskId, { select: ['assignee', 'invoice'] })` returns `assignee`,
omits `invoice`, and reports `meta.fields.invoice.status: 'unavailable'` with
partial completeness. Neither Task nor its stored invoice link is deleted.
Requiring a complete result rejects that selection. Task's own authorization
still applies.

This focused case executes through public packages on memory and Postgres in
[the deleted-reference suite](../../../tests/support/deleted-reference-contract.ts).
Existing source-read and traversal suites retain stale fallback, permission
expiry, `stale: 'omit'`, completeness, deleted/reassigned invoice and reference
evidence coverage. These cases need not be duplicated in the large escalation
scenario. See the
[reference lifecycle contract](../../../packages/node/NATIVE_ACTIONS.md#references-after-a-target-is-deleted)
for the result shape and the separate future edit/deletion decisions.

## Implemented pagination infrastructure

`@relate/protocol` owns `Page<T>`/`PageMeta`; `@relate/runtime` implements
`createQuery`/`QueryResult<T>`. Its unit tests verify lazy/shared first-page
execution, single-page awaiting, iteration through empty pages, preserved
records/evidence, early exit, malformed metadata, unchanged/cyclic cursors,
resumption and error propagation. Type probes verify selected fields and to-many
iteration while to-one remains a promise. The escalation now uses `for await`.

These are helper-level checks, not execution of the table's native actions.
Query ordering/scope, scan progress and budgets, authorization across pages,
concurrent changes and transactional rollback require their own operation-level
integration evidence; the generic helper tests do not establish them. A new
token alone cannot prove a new scan position. Exactly 1,000 results remains
valid only on exhaustion; failure while checking subsequent pages must still
fail the action.
