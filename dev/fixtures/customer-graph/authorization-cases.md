# Authorization cases exposed by the authoring exploration

Status: **required runtime outcomes; nested read-policy authoring selected**.
The graph now expresses organization conditions through customer references.
These declarations do not execute authorization and this file is not a passing
behavioral test. No implicit permission inheritance is introduced. Object
policies remain on the graph; action policies stay colocated.

## Concrete setup

Use the records in `validation/records.ts` and principals in
`validation/setup.ts`:

- Ana: employee/account-manager, `org_north`; Fin: employee/finance,
  `org_north`.
- Sara: employee/account-manager, `org_south`.
- Northwind (`crm_456`) and its `inv_1`/`inv_2`; Southbank (`crm_789`) and its
  open invoice `inv_south`. Adopt all records, retaining Relate-assigned IDs.
- In separate authorized invocations, Ana escalates Northwind and Sara escalates
  Southbank. Retain each returned review ID and task IDs. These actions provide
  both organizations' native child records without a special insertion API.

The creation and read requirements below must agree: being able to construct
this setup must not require an undocumented authorization bypass.

## Required authorization outcomes

- Ana's direct get/query and traversals expose no Southbank children. Known
  hidden IDs must not reveal more than unknown IDs.
- Sara can read Southbank's ordinary fields; finance still gates financial
  fields.
- Ana cannot use a Southbank customer reference to create a review merely
  because she has the account-manager role. The explicit customer read rejects;
  native write policy must also prevent unauthorized links if code omits that
  read.
- Fin cannot execute the actions despite being able to read Northwind.
- An account-manager without employee access cannot pass the examples' object
  reads. No implicit permission is derived from an input reference.
- Invoice review reads its customer ID first; a later denied customer lookup
  rejects without hidden data disclosure.
- Losing roles or organization access prevents unauthorized saved-receipt
  access. Knowing an idempotency key or supplying identical input is not
  authorization.

Checks on runtime object operations can reject after implementation entry. They
need not occur in a universal upfront preparation phase. A late denial or final
validation failure rolls back all native business effects of the invocation.
Invocation-specific policies that must reject before entry remain an open API.

## Native writes and final-state validation

Future execution tests should deliberately attempt to create a review as another
user, link a Northwind task to a Southbank invoice/customer/review, and supply
missing or wrong-type IDs. All must reject under the applicable policy/integrity
rules without partial native commits or hidden-value disclosure.
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


Also reject inconsistent customer references across otherwise readable task,
invoice and review records. Readability alone does not establish consistency or
write permission. Newly created reviews must be usable by later task creations
in the same transaction; validation must account for these records. These are
application requirements, not hardcoded universal review/task semantics.

## Decisions still needed

1. Enforcement of the declared related-object organization predicates for direct
   reads, queries and traversal. Trusted evidence authority, missing/stale
   references and reference-ID disclosure remain open; delegation is deferred.
2. Composition of action-local checks and object write rules, and immediate
   versus final-state validation for interleaved writes.
3. Trusted access to hidden validation evidence without exposing it through
   code, traces, output or errors.
4. Same-customer constraints and eligible-assignee checks. Assignee remains a
   string; no employee directory model is introduced here.
5. Current receipt authorization and cross-actor idempotency when both actors
   are permitted but effects contain actor-specific values.

See [open questions](./open-questions.md). Read predicates now have an authoring
shape; write authorization and evidence semantics remain design work. Neither is
solved by changing execution shape.
