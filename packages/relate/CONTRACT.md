# relate contract

## Portable application and extension contracts

`connect`, `defineApp`, and their `Connection`, `AppBindings`, `AppDefinition`,
and `AppSetupContext` types belong to `relate`. `connect` creates a frozen
binding and defaults authorization to `shared-service`; it does not open a
connection. `defineApp` preserves the exact graph type and stores deferred setup
without invoking it. `isAppDefinition` recognizes the descriptor across module
instances. Execution and registered cleanup belong to `startApp` in
`@relate/node`.

`relate/connectors` owns `SourceConnector`, `SourceRecord`, `SourceVersion`,
`SourceBinding`, and `SourceAccessDenied`. This is the existing resource-read
contract: account identification and fetching a known source record ID. It does
not yet define system factories, resource discovery, synchronization, or
external writes. Account evidence and denial/deletion semantics are unchanged;
see the [runtime contract](../runtime/CONTRACT.md).

`relate/storage` exports storage interface types needed by app setup and runtime
implementations. `@relate/runtime/storage` continues to re-export those types
alongside its errors and observation-ordering implementation. Neither portable
extension entry point imports graph authoring, compiler, or host code. The root
`relate` entry point has no runtime or Node-host dependency.

Import migration: authoring helpers previously exported by `@relate/node` now
come from `relate`; connector types and `SourceAccessDenied` previously exported
by `@relate/runtime` now come from `relate/connectors`.

Detailed behavior of the current slice. For an overview of the package, see
[README.md](./README.md).

TypeScript authoring and compiled-model contracts for authorized Customer and
Invoice reads and native account-review actions. Private and unpublished while
implementation is in progress.

- `relate`: `defineSource`, `source`, `defineObject`, `objectId`, `native`,
  `from`, `reference`, `referenceInput`, `defineRelationship`, `defineAccess`,
  `defineGraph`, `assertFields`, `nativeMembership`, `defineAction`,
  `implementAction`.
- `relate/compiler`: `compile`, with deterministic SHA-256 definition revisions.
- `relate/model`: portable manifest validation and types for runtime
  integrations.

Authoring imports do not import the compiler or Node APIs. The compiler
validates explicit stable `id` values, source references, canonical identity,
field classifications, and policy dependencies, then returns an immutable,
serializable manifest. Property renames preserve their IDs and change the
definition revision.

The current manifest format is **4**. Source observations, native values,
authorization evidence and persisted value history use stable property IDs;
consumer results retain property names. Formats 1, 2 and 3 must be recompiled.
Format 4 adds portable scalar bounds and declared action failure schemas.
Recompilation also changes the installed revision, preventing an existing
name-keyed store from being read as ID-keyed data. Existing installations need
an explicit data/revision migration; see the
[storage contract](../runtime/STORE_CONTRACT.md#property-identity).

This slice supports a single membership source per object, scalar string/number/
boolean fields (including optional/nullable wrappers), a generated canonical
string object ID, explicit ordinary/restricted field groups, role gates, and
root and nested property-to-claim equality predicates. Each registered object
requires a read policy; use `read: 'deny'` for intentional denial. Source
schemas use ordinary `z.object` definitions. Unmapped JSON fields are retained
privately.

Arbitrary refinements, transforms, defaults, nested property values, and custom
policy handlers are rejected rather than silently compiled away. Policies in
this slice are fully declarative, so no executable handler registry is needed
for authorization. Native scalar properties, native references, action contracts
and create policies are supported; see the
[native action walkthrough](../node/NATIVE_ACTIONS.md). Release artifacts,
schema evolution, external actions and additional source bindings remain future
implementation work. The installed graph is pinned to one definition revision;
incompatible activation requires an explicit migration.

See [the runnable example](../../examples/01-hello-world/README.md).

Named object registries (`objects: { Customer }`) preserve consumer API names
and property inference through `@relate/node`. Objects and policies use matching
registry keys. Registry names do not replace stable definition IDs. `ObjectData`
and `PropertyNames` expose selected property types; selected values remain
optional because reads can withhold unavailable fields.

## Object names and display metadata

The object registry key is the canonical public API name. For example,
`objects: { AccountReview }` compiles to `apiName: 'AccountReview'` and names
`consumer.objects.AccountReview` in the typed SDK. API and SDK integrations must
use this machine name, never a display label. Separate route and SDK name
overrides are not part of the contract.

Objects optionally declare presentation metadata:

```ts
const AccountReview = defineObject({
  id: 'business.account-review',
  label: 'Account review',
  pluralLabel: 'Account reviews',
  description: 'An assessment of a customer account and its next steps.',
  // membership and properties…
});
```

`label` defaults to a humanized registry key (`AccountReview` becomes
`Account Review`). `pluralLabel` defaults to the resolved singular label; Relate
does not guess plurals. Supply explicit collection labels such as `People` where
needed. `description` stays absent when omitted. Supplied labels must be
nonblank; different object types may share display labels.

Compilation resolves labels and preserves `apiName`, `label`, `pluralLabel`, and
any `description` in the portable manifest. Display changes preserve API
addressing and definition IDs. Registry key changes rename the public API but
preserve definition IDs. Both changes affect the definition revision; the
existing installed-graph revision checks still apply.

Migration: replace object-level `name` with `label`, optionally add
`pluralLabel` and `description`, and recompile. Manifest format 2 introduced the
replacement of object `name` with `apiName` and the resolved display labels.
Format 1 manifests are rejected; their discarded registry keys cannot be
recovered safely from display labels. Property and relationship names retain
their existing meaning.

Each object declares exactly one `objectId({ id })` property, conventionally
named `id`. Relate owns its string schema and generates its value on adoption.
There is no object-level `key` selector. `defineObject`, the compiler, and
manifest validation reject missing or multiple ID properties.

`defineObject` creates a frozen copy of each property and binds it to the
returned object through `.owner`. It leaves the input properties unchanged;
reusing them in another definition creates separate bound copies. Use properties
from the returned object, such as `Invoice.properties.customer`, when defining
relationships.

`id` identifies a graph, source, object, or property definition and stays stable
across renames. `objectId` identifies a Relate record; `sourceRecordId`
identifies its external record. Sources declare `idField` to select the external
ID field from their validated schema. These identities are separate: adopting an
external record generates a Relate object ID and retains the mapping. Existing
definition ID strings are preserved.

Consumer IDs use `ObjectId<'business.customer'>`, a branded string keyed by the
stable object definition ID. `ObjectData` and `PropertyValue` infer this brand
for own ID properties and the target brand for reference properties. Selected
fields remain optional. Source keys, definition IDs, storage, and protocol JSON
remain strings; the compiled-model engine keeps its dynamic string interface.

For external input, use `referenceInput(Customer).parse(rawValue)`. The schema
accepts a nonblank string without changing its contents and returns a branded
ID, with no wrapper. Its TypeScript input and output types both carry the brand,
so typed callers cannot pass another object's ID or a raw string. Zod's
`parse(unknown)` is the explicit external boundary. The schema also works in
object/array schemas and for ID outputs, and its JSON Schema remains a string.
Parsing declares the expected type; it proves neither membership, existence, nor
authorization. Reads continue to check those at runtime.

## Typed policies

Declare roles, claim schemas, and field groups once, before defining objects:

```ts
const access = defineAccess({
  roles: ['employee', 'finance'],
  claims: { portfolio: z.string() },
  fieldGroups: ['ordinary', 'financial'],
});
```

Properties default to `ordinary` when `access` is omitted from `objectId`,
`from`, `native`, or `reference`. Set `access: access.groups.financial` for a
restricted field. The access declaration must still include `ordinary`. Key
policies by the objects registered in the same `defineGraph` call:

```ts
const graph = defineGraph({
  id: 'business.graph',
  objects: { Customer, Invoice },
  access,
  policies: {
    Customer: {
      read: {
        gate: access.role('employee'),
        where: { portfolio: { eq: access.claims.portfolio } },
        evidenceMaxAgeMs: 30_000,
      },
      groups: { financial: access.role('finance') },
    },
    Invoice: { read: 'deny' },
  },
});
```

TypeScript catches misspelled role, claim, and group names, incompatible claim
value types, unknown object keys, and missing policies or read decisions. Nested
predicates infer from the same object registry, including predicates extracted
into variables. Object IDs must use the ordinary group. Restricted groups
require their own role gate in addition to the object rule. A denied read cannot
have field-group grants.

`compile()` lowers references into portable IDs and records. It validates roles,
claims, field groups, property dependencies, comparison types, policy coverage,
and duplicate object definition IDs; `validateManifest()` also validates loaded
JSON. Claim schemas support the same portable scalars as properties. Hosts
supply authenticated principals; claim declarations do not authenticate or
populate claims. Missing claims deny access, and supplied claim values are
checked against their declared schema.

Migration: replace object arrays with `objects: { Customer, Invoice }`, and
policy-call arrays with `policies: { Customer: { read: ... }, Invoice: ... }`.
Remove `access.forObjects`, `access.policy`, and `equals`; direct comparisons
use `where: { portfolio: { eq: access.claims.portfolio } }`. Role-only reads
omit `evidenceMaxAgeMs`; predicate reads require it. Use `read: 'deny'` instead
of omitting an object's policy.

The compiler lowers explicit denial to an absent manifest policy. Runtime and
loaded manifests retain default-deny behavior. Registry aliases map to stable
object IDs; renaming a registry key and its policy key changes the manifest's
`apiName` and definition revision, while preserving durable definition IDs.
Recompile models after migration: direct predicates now use the same portable
path representation as nested predicates, which changes definition revisions.

## Source-backed references

```ts
customer: reference(Customer, {
  id: 'invoice.customer',
  from: invoices.fields.customer_id,
});
```

The source field must be a required string containing the target membership
source's record ID. Resolution looks up an already-adopted Customer within the
current graph, connection, source and object type; the returned value is its
canonical Relate ID. An unmapped key never adopts a target or becomes a guessed
ID. Additional source aliases and exact-match enrichment are not implemented.

Nested predicates use the target object inferred from the reference property:

```ts
const graph = defineGraph({
  id: 'invoice-graph',
  objects: { Customer, Invoice },
  access,
  policies: {
    Customer: { read: 'deny' },
    Invoice: {
      read: {
        gate: access.role('employee'),
        where: { customer: { portfolio: { eq: access.claims.portfolio } } },
        evidenceMaxAgeMs: 30_000,
      },
      groups: { financial: access.role('finance') },
    },
  },
});
```

Nested predicates compare explicit related attributes privately. They do not
inherit the target's read policy or field-group grants. All conditions must
match; each source-backed hop and terminal value must have retained evidence
within the rule's age bound. Missing, expired or unresolved evidence denies the
owner read. The bound is independent of the caller's data freshness options.
Paths support up to 16 properties. Role-only rules use `read: { gate }`.

Disclosing a reference ID additionally requires a readable target and a current,
retained reference. Otherwise that selected field is `unavailable`; its source
key and private evidence never enter the response. Finance access grants
financial fields only after the object's portfolio rule succeeds.

See the executable
[Invoice model](../../dev/fixtures/customer-graph/invoice-read/model.ts) and its
[acceptance suite](../../tests/support/invoice-read-contract.ts).

## Relationships

```ts
const CustomerInvoices = defineRelationship({
  id: 'business.customer-invoices',
  via: Invoice.properties.customer,
  forward: 'invoices',
  reverse: 'customer',
});
// Include relationships: { CustomerInvoices } in defineGraph(...).
```

`via` determines both endpoints: its target is `Customer` (`from`), and its
owner is `Invoice` (`to`). The reference also determines traversal cardinality:

- `Customer.traverse.invoices` returns many invoices, with pagination.
- `Invoice.traverse.customer` returns at most one customer, without pagination.

Authors provide only the relationship ID, bound reference and traversal names.
TypeScript rejects scalar properties and references that have not been bound by
`defineObject`, and preserves the target fields and branded IDs in both
directions. A to-one traversal can return `not-found` when the reference is
unresolved or access is denied.

The compiler validates that the exact endpoint objects and bound reference are
registered in the graph. Names must be unique among traversals on the same
object; reference properties and traversal names use separate namespaces.
Existing graphs can omit the relationship registry. Native references support
authorized get/create in the native-action slice; traversal over those
references and independent relationship records remain unimplemented.

Migration: remove authored `from` and `to`, and replace each
`{ name, cardinality }` traversal with its name string. Keep the existing
relationship ID and `via`. The compiled manifest format and runtime traversal
behavior are unchanged.

## Require values after a read

`assertFields(result, fields)` is an optional presence check on a result you
already have. Use it when an operation cannot proceed without particular values.
Ordinary reads remain partial and best-available by default.

```ts
import { assertFields } from 'relate';

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
full escalation scenario remains a proposed API. Graph queries now execute for
consumers and native action implementations; see the
[query contract](../runtime/CONTRACT.md#graph-queries). The smaller
[native account-review path](../node/NATIVE_ACTIONS.md) is executable.

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

`requireComplete: true` is different: it rejects forbidden or unavailable
evidence across the read selection, but a known absent optional field still
counts as complete evidence. `assertFields` requires actual values for its named
fields and allows other fields to remain forbidden or unavailable. Neither
presence nor complete evidence alone guarantees freshness.

Reads still happen when your implementation needs them. A later lookup can use
an ID from an earlier result, and assertions run on the results actually
returned. No upfront required-read declaration or preparation phase is needed.

## Portable scalar constraints

String `.min(n)`, `.max(n)` and `.length(n)` and numeric `.min(n)`/`.gte(n)`,
`.max(n)`/`.lte(n)`, `.gt(n)` and `.lt(n)` compile to JSON bounds. For example,
`z.string().min(1).max(4000)` produces `minLength: 1, maxLength: 4000`. Lengths
count Unicode code points, matching the supported Zod version; an emoji counts
as one code point. Numbers must be finite. Optional and nullable wrappers retain
their semantics. Chained bounds all apply, including exclusive bounds.

These constraints apply consistently to action inputs/outputs, native
properties, source fields, claims and declared error details. Discovery
preserves the bounds; loading the manifest validates their shape and scalar
type. Runtime validation uses this portable metadata, so an application cannot
bypass a native property limit by supplying a valid action input and
constructing an invalid value inside the handler. Unsupported checks (including
regex, arbitrary refinements, formats, integer checks, transforms, defaults and
coercion) still reject compilation.

Actions may declare `errors: { inactive: z.object({}) }`. Their implementation
can call `fail('inactive', {})`; callers receive a typed failed receipt after
native rollback. Error details use the same portable object fields and required
`referenceInput` fields as action input/output. Empty objects are supported. See
[native action outcomes](../node/NATIVE_ACTIONS.md#declared-business-failures)
for persistence, replay and disclosure rules.
