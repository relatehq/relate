# relate

TypeScript authoring and compiled-model contracts for authorized Customer and
Invoice reads. Private and unpublished while implementation is in progress.

- `relate`: `defineSource`, `source`, `defineObject`, `objectId`, `native`,
  `from`, `reference`, `defineRelationship`, `defineAccess`, `equals`,
  `defineGraph`.
- `relate/compiler`: `compile`, with deterministic SHA-256 definition revisions.
- `relate/model`: portable manifest validation and types for runtime
  integrations.

Authoring imports do not import the compiler or Node APIs. The compiler
validates explicit stable `id` values, source references, canonical identity,
field classifications, and policy dependencies, then returns an immutable,
serializable manifest. Property renames preserve their IDs and change the
definition revision.

This slice supports a single membership source per object, scalar string/number/
boolean fields (including optional/nullable wrappers), a generated canonical
string object ID, explicit ordinary/restricted field groups, role gates, and
root and nested property-to-claim equality predicates. An absent policy denies
access. Source schemas use ordinary `z.object` definitions. Unmapped JSON fields
are retained privately.

Refinements, transforms, defaults, nested values, other native fields, and
custom handlers are rejected rather than silently compiled away. Policies in
this slice are fully declarative, so no executable handler registry is needed
yet. Release artifacts, schema evolution, actions, and additional source
bindings remain future implementation work. The installed graph is pinned to one
definition revision; incompatible activation requires an explicit migration.

See [the runnable example](../../examples/hello-world/README.md).

Named object registries (`objects: { Customer }`) preserve consumer API names
and property inference through `@relate/node`. Existing object arrays still
compile to the same portable manifest. Registry names do not replace stable
definition IDs. `ObjectData` and `PropertyNames` expose selected property types;
selected values remain optional because reads can withhold unavailable fields.

Each object declares exactly one
`objectId({ id, access: access.groups.ordinary })` property, conventionally
named `id`. Relate owns its string schema and generates its value on adoption.
There is no object-level `key` selector. `defineObject`, the compiler, and
manifest validation reject missing or multiple ID properties.

`id` identifies a graph, source, object, or property definition and stays stable
across renames. `objectId` identifies a Relate record; `sourceRecordId`
identifies its external record. Sources declare `idField` to select the external
ID field from their validated schema. These identities are separate: adopting an
external record generates a Relate object ID and retains the mapping. Existing
definition ID strings are preserved.

## Typed policies

Declare roles, claim schemas, and field groups once, before defining objects:

```ts
const access = defineAccess({
  roles: ['employee', 'finance'],
  claims: { portfolio: z.string() },
  fieldGroups: ['ordinary', 'financial'],
});
```

Classify properties with `access.groups.ordinary` or `access.groups.financial`.
Bind a policy to its object and compare property and claim references:

```ts
const graph = defineGraph({
  id: 'business.graph',
  objects: [Customer],
  access,
  policies: [
    access.policy(Customer, {
      read: {
        gate: access.role('employee'),
        where: equals(Customer.properties.portfolio, access.claims.portfolio),
        evidenceMaxAgeMs: 30_000,
      },
      groups: { financial: access.role('finance') },
    }),
  ],
});
```

TypeScript catches misspelled role, claim, and group names, incompatible claim
value types, and predicates referring to another object's properties. Object IDs
must use the ordinary group. An absent object policy denies access; restricted
groups require their own role gate in addition to the object rule.

`compile()` lowers references into portable IDs and records. It validates roles,
claims, field groups, property dependencies, comparison types, and duplicate
policies; `validateManifest()` also validates loaded JSON. Claim schemas support
the same unrefined scalars as properties. Hosts supply authenticated principals;
claim declarations do not authenticate or populate claims. Missing claims deny
access, and supplied claim values are checked against their declared schema.

Migration from the earlier authoring API: replace string `access` values with
group references, move `fieldGroups` into `defineAccess`, and replace ID-keyed
policy records with an array of `access.policy(Object, ...)` definitions.
Recompile existing models: the manifest now also requires role declarations and
claim schemas, so older manifests and definition revisions are incompatible.

## Source-backed references

```ts
customer: reference(Customer, {
  id: 'invoice.customer',
  access: access.groups.ordinary,
  from: invoices.fields.customer_id,
});
```

The source field must be a required string containing the target membership
source's record ID. Resolution looks up an already-adopted Customer within the
current graph, connection, source and object type; the returned value is its
canonical Relate ID. An unmapped key never adopts a target or becomes a guessed
ID. Additional source aliases and exact-match enrichment are not implemented.

Bind the object registry once to author nested read predicates:

```ts
const { policy } = access.forObjects({ Customer, Invoice });
const invoicePolicy = policy(Invoice, {
  read: {
    gate: access.role('employee'),
    where: { customer: { portfolio: { eq: access.claims.portfolio } } },
    evidenceMaxAgeMs: 30_000,
  },
  groups: { financial: access.role('finance') },
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
  from: Customer,
  to: Invoice,
  forward: { name: 'invoices', cardinality: 'many' },
  reverse: { name: 'customer', cardinality: 'one' },
  via: Invoice.properties.customer,
});
// Include relationships: { CustomerInvoices } in defineGraph(...).
```

The reference on `to` must target `from`. This source-backed slice supports
forward-to-many and reverse-to-one traversal; native or independent relationship
records are not implemented. The compiler validates registered endpoints,
reference ownership and direction names. Names must be unique among traversals
on the same object; reference properties and traversal names use separate
namespaces. Existing graphs can omit the relationship registry.
