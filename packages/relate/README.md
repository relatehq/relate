# relate

Define a business graph in TypeScript and compile it into a portable model.
Private and unpublished while implementation is in progress.

## Responsibility

`relate` owns the authoring API and the compiled-model contract:

- `relate`: `defineSource`, `defineObject`, `defineRelationship`,
  `defineAccess`, `defineAction` and `defineGraph`; the property constructors
  `objectId`, `from`, `native` and `reference`; `source` and `nativeMembership`;
  `implementAction`; and the boundary helpers `referenceInput` and
  `assertFields`.
- `relate/compiler`: `compile(graph)` validates a definition and returns an
  immutable, serializable `CompiledModel` with a deterministic `sha256:`
  definition revision.
- `relate/model`: the manifest schema, `validateManifest`, and the types that
  runtime integrations consume.
- `relate/diagnostics`: platform-neutral issue types (`ModelIssue`, `IssuePath`,
  `SourceSite`), stable `ModelIssueCode`s, and the `CompileError` /
  `ManifestValidationError` classes thrown by authoring, compilation and
  manifest validation. It imports nothing.

It does not fetch, store, authorize or serve anything at runtime. Authoring
imports stay free of compiler and Node dependencies.

## How it fits

- Depends on `zod` and `@relate/protocol` (result and evidence types).
- `@relate/node` compiles an authored graph and infers the typed consumer API
  from its object registry.
- `@relate/runtime` and `@relate/postgres` import only `relate/model`. They
  execute compiled manifests and never see authoring objects.

## Public API

```ts
import { z } from 'zod';
import {
  defineAccess,
  defineGraph,
  defineObject,
  defineRelationship,
  defineSource,
  from,
  objectId,
  reference,
  source,
} from 'relate';
import { compile } from 'relate/compiler';

// Sources keep ownership of their records.
const crm = defineSource({
  id: 'crm.customers',
  idField: 'id',
  schema: z.object({ id: z.string(), name: z.string(), region: z.string() }),
});
const billing = defineSource({
  id: 'billing.invoices',
  idField: 'id',
  schema: z.object({ id: z.string(), customer_id: z.string() }),
});

// Roles, claims and field groups are declared once and checked by TypeScript.
const access = defineAccess({
  roles: ['sales'],
  claims: { region: z.string() },
  fieldGroups: ['ordinary'],
});

const Customer = defineObject({
  id: 'business.customer',
  membership: source(crm),
  properties: {
    id: objectId({ id: 'business.customer.id' }),
    name: from(crm.fields.name, { id: 'business.customer.name' }),
    region: from(crm.fields.region, { id: 'business.customer.region' }),
  },
});

const Invoice = defineObject({
  id: 'business.invoice',
  membership: source(billing),
  properties: {
    id: objectId({ id: 'business.invoice.id' }),
    customer: reference(Customer, {
      id: 'business.invoice.customer',
      from: billing.fields.customer_id,
    }),
  },
});

const CustomerInvoices = defineRelationship({
  id: 'business.customer-invoices',
  via: Invoice.properties.customer,
  forward: 'invoices',
  reverse: 'customer',
});

const graph = defineGraph({
  id: 'business',
  objects: { Customer, Invoice },
  relationships: { CustomerInvoices },
  access,
  policies: {
    Customer: {
      read: {
        gate: access.role('sales'),
        where: { region: { eq: access.claims.region } },
        evidenceMaxAgeMs: 30_000,
      },
    },
    Invoice: {
      read: {
        gate: access.role('sales'),
        where: { customer: { region: { eq: access.claims.region } } },
        evidenceMaxAgeMs: 30_000,
      },
    },
  },
});

const model = compile(graph);
model.manifest.objects.map((o) => o.apiName); // ['Customer', 'Invoice']
model.definitionRevision; // 'sha256:…', deterministic for this definition
```

Registry keys such as `Customer` are the public API names. `id` values are
stable definition identities that survive renames. Applications normally pass
`graph` to `@relate/node`, which compiles it for them; call `compile` directly
when you need the manifest itself.

## Diagnostics

Validation failures are structured. `compile(graph)` collects every independent
issue, skips checks that depend on a failed prerequisite, and throws one
`CompileError` whose `issues` are deduplicated and ordered by path:

```ts
import { CompileError } from 'relate';
import { compile } from 'relate/compiler';

try {
  compile(graph);
} catch (error) {
  if (error instanceof CompileError)
    for (const issue of error.issues)
      console.log(issue.code, issue.message, issue.definitionId, issue.path);
  // policy.unknown-role  Unknown policy role 'finanse' in policy Invoice.read
  //   example.invoice  { root: 'graph', segments: ['policies', 'Invoice', 'read', 'gate'] }
}
```

Paths name their root: `graph` for the object passed to `compile`, `definition`
for an early failure inside `defineObject`/`defineAction`, and `manifest` for
`validateManifest` input. Issues found while lowering to a Manifest are
translated back to authored registry keys when that mapping is unambiguous;
otherwise they keep the explicit `manifest` root. Consumers branch on `code`,
never on message text.

Development hosts can record where definitions were declared with
`enableDefinitionProvenance()` before importing user modules and read the raw
capture with `definitionProvenance(definition)`. Capture is off by default,
stays outside the Manifest and never changes `definitionRevision`.

## Status

Implemented: one membership source per object, scalar fields, source-backed and
native references, relationships, declarative read and create policies, native
action contracts. Not implemented: multi-source enrichment, schema evolution and
model migrations, external actions.

## Further reading

- [CONTRACT.md](./CONTRACT.md): detailed authoring, policy, reference,
  relationship and `assertFields` behavior, including migration notes.
- [Hello world](../../examples/hello-world/README.md): the smallest runnable
  graph.
- [Native actions](../node/NATIVE_ACTIONS.md): `defineAction` and
  `implementAction` end to end.
