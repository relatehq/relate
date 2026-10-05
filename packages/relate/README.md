# relate

TypeScript authoring and compiled-model contracts for the first Customer read.
Private and unpublished while implementation is in progress.

- `relate`: `defineSource`, `source`, `defineObject`, `objectId`, `native`,
  `from`, `defineGraph`.
- `relate/compiler`: `compile`, with deterministic SHA-256 definition revisions.
- `relate/model`: portable manifest validation and types for runtime
  integrations.

Authoring imports do not import the compiler or Node APIs. The compiler
validates explicit stable `definitionId` values, source references, canonical
identity, field classifications, and policy dependencies, then returns an
immutable, serializable manifest. Property renames preserve their IDs and change
the definition revision.

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
`objectId({ definitionId, access: 'ordinary' })` property, conventionally named
`id`. Relate owns its string schema and generates its value on adoption. There
is no object-level `key` selector. `defineObject`, the compiler, and manifest
validation reject missing or multiple ID properties.

`definitionId` identifies a graph, source, object, or property definition and
stays stable across renames. `objectId` identifies a Relate record;
`sourceRecordId` identifies its external record. Sources declare `idField` to
select the external ID field from their validated schema. These identities are
separate: adopting an external record generates a Relate object ID and retains
the mapping. Existing definition ID strings are preserved.
