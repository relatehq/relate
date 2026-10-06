# relate

TypeScript authoring and compiled-model contracts for the first Customer read.
Private and unpublished while implementation is in progress.

- `relate`: `defineSource`, `source`, `defineObject`, `objectId`, `native`,
  `from`, `defineAccess`, `equals`, `defineGraph`.
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
string object ID, explicit ordinary/restricted field groups, role gates, and a
property-to- trusted-claim equality predicate. An absent policy denies access.
Source schemas use ordinary `z.object` definitions. Unmapped JSON fields are
retained privately.

Refinements, transforms, defaults, nested values, other native fields, and
custom handlers are rejected rather than silently compiled away. Policies in
this slice are fully declarative, so no executable handler registry is needed
yet. Release artifacts, schema evolution, relationships, actions, and additional
source bindings remain future implementation work. The installed graph is pinned
to one definition revision; incompatible activation requires an explicit
migration.

See [the runnable example](../../examples/hello-world/README.md).

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
  claims: { organization: z.string() },
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
        where: equals(
          Customer.properties.organization,
          access.claims.organization,
        ),
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
