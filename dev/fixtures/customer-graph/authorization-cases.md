# Authorization cases exposed by the authoring exploration

Status: **required runtime outcomes; read/create policies and declarative
integrity selected**. The graph now expresses portfolio conditions through
customer references. These declarations do not execute authorization and this
file is not a passing behavioral test. No implicit permission inheritance is
introduced. Object policies remain on the graph; action policies stay colocated.

## Concrete setup

One company runs this instance. Customer portfolios are internal account
assignments, not separate tenant organizations. Northwind is in the North
portfolio; Southbank is in the South portfolio. Ana and Fin are assigned to
North, Sara to South. Finance is a separate field-access role; it does not grant
access to every portfolio. One portfolio per caller keeps this example small;
multiple assignments are a future collection-predicate case.

Use the records in `validation/records.ts` and principals in
`validation/setup.ts`:

- Ana: employee/account-manager, `portfolio_north`; Fin: employee/finance,
  `portfolio_north`.
- Sara: employee/account-manager, `portfolio_south`.
- Northwind (`crm_456`) and its `inv_1`/`inv_2`; Southbank (`crm_789`) and its
  open invoice `inv_south`. Adopt all records, retaining Relate-assigned IDs.
- In separate authorized invocations, Ana escalates Northwind and Sara escalates
  Southbank. Retain each returned review ID and task IDs. These actions provide
  both portfolios' native child records without a special insertion API.

The creation and read requirements below must agree: being able to construct
this setup must not require an undocumented authorization bypass.

## Required authorization outcomes

- Ana's direct get/query and traversals expose no Southbank children. Known
  hidden IDs must not reveal more than unknown IDs.
- Sara can read Southbank's ordinary fields; finance still gates financial
  fields.
- Ana cannot use a Southbank customer reference to create a review merely
  because she has the account-manager role. The explicit customer read rejects;
  the declared create rule must reject it even if code omits that read.
- Fin cannot execute the actions despite being able to read Northwind.
- An account-manager without employee access cannot pass the examples' object
  reads. No implicit permission is derived from an input reference.
- Invoice review reads its customer ID first; a later denied customer lookup
  rejects without hidden data disclosure.
- Losing roles or portfolio access prevents unauthorized saved-receipt access.
  Knowing an idempotency key or supplying identical input is not authorization.
  Both [lookup and replay](./receipts.md) reject without exposing stored output
  or error details; a retrieval denial never changes a committed success into a
  failed invocation. The caller scenario covers role and portfolio revocation.

Checks on runtime object operations can reject after implementation entry. They
need not occur in a universal upfront preparation phase. A late denial or final
validation failure rolls back all native business effects of the invocation.
Invocation-specific policies that must reject before entry remain an open API.

## Shared read enforcement

Consumers and action implementations use the same `get`, `query` and `traverse`
contract. Runtime implementation must share policy enforcement across these
entry points; invoking an action does not elevate the caller's read access.

- Apply object and field policies to direct reads, filtered and unfiltered
  queries, both traversal directions, and native read-your-writes. Traversal
  must not bypass checks on the starting object, relationship reference or
  target.
- Caller-supplied filters require permission to read their fields, even when
  those fields are absent from `select`. Reject unauthorized filters without
  consulting or disclosing hidden values. For example, Ana cannot probe
  `totalMinor` through invoice matches; Fin may filter it on permitted invoices.
  Runtime-only policy evidence is separate from caller-supplied filtering.
- Unknown or unavailable filter evidence is not a non-match. This fixture
  requires rejection when a query cannot establish matches; a future explicit
  incomplete-query result must not imply complete enumeration.
- Use the same cursor, page-size and exhaustion rules on both surfaces. Empty
  pages may be non-final. Continuations must remain bound to the query/traversal
  and authorized caller context, and must enforce current access on every page.
  Pagination metadata and errors must not expose hidden records or values.

These are required runtime behaviors, not implemented guarantees. Exact errors,
snapshot consistency and enforcement mechanics remain implementation/design
work; sharing TypeScript interfaces alone does not establish them.

## Native writes and final-state validation

Future execution tests should deliberately attempt to create a review as another
user, link a Northwind task to a Southbank invoice/customer/review, and supply
missing or wrong-type IDs. All must reject under the applicable policy/integrity
rules without partial native commits or hidden-value disclosure.

Also reject inconsistent customer references across otherwise readable task,
invoice and review records. Readability alone does not establish consistency or
write permission. Newly created reviews must be usable by later task creations
in the same transaction; validation must account for these records. These are
application requirements, not hardcoded universal review/task semantics.

## Decisions still needed

1. Enforcement of the declared related-object portfolio predicates for direct
   reads, queries and traversal. Trusted evidence authority, missing/stale
   references and reference-ID disclosure remain open; delegation is deferred.
2. Runtime enforcement of action-local checks and declared object write rules,
   and immediate versus final-state validation for interleaved writes.
3. Trusted access to hidden validation evidence without exposing it through
   code, traces, output or errors.
4. Same-customer constraints and eligible-assignee checks. Assignee remains a
   string; no employee directory model is introduced here.
5. Current receipt authorization and cross-actor idempotency when both actors
   are permitted but effects contain actor-specific values.

See [open questions](./open-questions.md). Read predicates now have an authoring
shape; write authorization and evidence semantics remain design work. Neither is
solved by changing execution shape.

## Write-policy exploration

Keep permission and relationship integrity separate:

- Ana creates a review for Northwind: permitted by her account-manager role and
  North portfolio assignment. Set its author to Ana.
- Ana supplies Southbank's ID, and the action omits its customer lookup: the
  object create rule must still reject a write outside her assigned portfolio.
- Ana supplies another employee as author: reject impersonation even though
  Northwind itself is in her portfolio.
- Use the second North-portfolio customer, Harbour Design (`crm_654`). Ana can
  read both, but a Task for Northwind must not link that other customer's
  invoice or review. This proves integrity independently of a portfolio-access
  denial.
- Create a review and then its task in the same invocation: validation must
  resolve the newly created review, while a later invalid link rolls back both.

The
[archived comparison](../../../../relate-internal/docs/internal/write-policy-spike.md)
records both APIs and their behavioral checks. The main fixture now selects
`create` plus declarative `integrity`; it does not execute these rules yet. For
the same-portfolio mismatch cases, adopt the additional `crm_654` customer and
`inv_north_other` invoice from `validation/records.ts`, then create a review for
that customer. Keep these extra adoptions out of the baseline read scenario so
its expected enumeration remains unchanged. Evidence authority and validation
timing remain open runtime contracts.
