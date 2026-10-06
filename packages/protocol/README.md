# @relate/protocol

Transport-neutral Customer read requests, results, evidence, and errors. Private
and unpublished. No runtime, database, or provider dependencies.

Results distinguish `not-found` from `ok`, then represent each requested field
as available, absent (a known optional value), or unavailable. Hidden, unknown
and unobtainable fields share the public unavailable shape. Null remains a
legitimate available value. Data is a partial JSON record, never typed as a
complete model.

Completeness, freshness, and durability are independent. Evidence reports source
identity only for authorized exposed values and never includes raw provider
errors or aliases. HTTP and MCP adapters are not implemented in this slice.

Field evidence separates the retention outcome from `retentionDurability`:
`volatile` for memory and `persistent` for storage that survives process
restart. A confirmed retention outcome alone is not a persistence guarantee.

## Require values after a read

`assertFields(result, fields)` is an optional presence check on a result you
already have. Use it when an operation cannot proceed without particular values.
Ordinary reads remain partial and best-available by default.

```ts
import { assertFields } from '@relate/protocol';

const customer = await runtime.read(principal, 'customer', customerId, {
  select: ['name', 'status'],
});

assertFields(customer, ['name', 'status']);
// The result is now narrowed to status: 'ok', with both values present.
// This runtime's values remain Json; presence does not infer a string schema.
console.log(customer.data.name, customer.data.status);
```

The helper checks `status: 'ok'`, then verifies that each named field is an own
property of `data` with a value other than `undefined`. It returns nothing on
success and throws `ReadError` with code `incomplete` on failure, including a
`not-found` result. The error does not distinguish hidden, absent, unselected,
or unavailable values. It contains no field values or provider details.

It does not fetch, refresh, change the result, or bypass authorization. Use it
on results produced by an authorized, schema-validating read; it is not a
validator for arbitrary external JSON. Evidence and unchecked fields remain
unchanged, including any partial/degraded state.

### Type narrowing and nullable fields

For a result with schema-specific types, the assertion preserves those types and
removes only `undefined` from the requested fields. For example, given a typed
customer result whose data has these fields:

```ts
type CustomerData = {
  name?: string;
  manager?: string | null;
  status?: 'active' | 'inactive';
};

// Given a typed ok/not-found result with CustomerData:
assertFields(customer, ['name', 'manager']);
customer.data.name; // string
customer.data.manager; // string | null
customer.data.status; // 'active' | 'inactive' | undefined

if (customer.data.manager === null) {
  throw new Error('Assign a manager first');
}
// manager is now string: this action needs an assigned manager.
```

`null` passes because a nullable schema can legitimately mean “no manager
assigned.” `false`, `0`, and `''` also pass. Invalid nulls must be rejected by
schema validation before this assertion. The helper does not read the schema or
invent a stronger non-null contract.

Inline field arrays and `as const` tuples narrow the named properties. A dynamic
array is still checked at runtime, but cannot establish specific fields in the
type system: it could be empty or contain only some possible names. Likewise,
checking a variable that is either `'name'` or `'status'` does not establish
both. An empty array asserts only `status: 'ok'`.

The current embedded runtime returns partial JSON records. The customer graph
[action fixture](../../dev/fixtures/customer-graph/source/actions/review-invoice.server.ts)
demonstrates schema-specific narrowing with this implemented helper, but its
typed object operations and action execution remain proposed APIs.

### Presence, freshness, and completeness

| Returned value                | Presence assertion               | Meaning                                                                  |
| ----------------------------- | -------------------------------- | ------------------------------------------------------------------------ |
| Fresh `'Acme'`                | Passes                           | A value was supplied and its evidence is fresh.                          |
| Stale `'Acme'`                | Passes                           | A value was supplied; an action may separately require fresher evidence. |
| `null` from a nullable schema | Passes                           | An explicit null value was supplied.                                     |
| Missing or `undefined`        | Throws `ReadError('incomplete')` | No usable value was supplied for this field.                             |

An action requiring freshness can inspect the checked field's evidence:

```ts
assertFields(customer, ['name']);
const evidence = customer.meta.fields.name;

if (evidence?.status !== 'available' || evidence.freshness !== 'fresh') {
  throw new Error('A fresh customer name is required');
}
```

Freshness reflects the read's age policy and observation evidence; it does not
promise an upstream snapshot. Set an appropriate `maxAgeMs` on the read when
needed. The existing `stale: 'omit'` option omits stale values, which then fail
the presence assertion. The helper itself introduces no freshness policy.

`requireComplete: true` is different: it rejects unavailable evidence across the
read selection, but a known absent optional field still counts as complete
evidence. `assertFields` requires actual values for its named fields and allows
other fields to remain unavailable. Neither presence nor complete evidence alone
guarantees freshness.

Reads still happen when your implementation needs them. A later lookup can use
an ID from an earlier result, and assertions run on the results actually
returned. No upfront required-read declaration or preparation phase is needed.

## Pages

`Page<T>` preserves each record's data and evidence in `data`. Its `meta` is a
`PageMeta` discriminated union: `{ exhausted: true }` omits the continuation,
while `{ exhausted: false, continuationCursor: string }` requires one. Types
also reject a cursor on the exhausted variant. Runtime validation rejects empty
tokens and contradictory metadata; these types alone do not validate JSON.

An empty page can have a continuation. Consumers must follow exhaustion, not
record count. The implemented pagination helper in
[`@relate/runtime`](../runtime/README.md#pagination) handles this contract;
collection query execution remains unimplemented.
