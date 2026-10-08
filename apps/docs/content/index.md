# Getting Started with Relate

> [!WARNING]
>
> Relate is at a very early stage and is not ready for use. It is published only
> for comment and discussion. The current package version is `0.0.0-dev.0`.

Relate is an open-source toolkit for building a shared, typed view of business
data across APIs and databases.

Instead of copying records into another database or warehouse, Relate reads from
your systems of record, such as CRM APIs and billing databases, while those
systems keep ownership of their records. It provides:

- **A unified TypeScript model** for objects, references, and traversal.
- **Declarative access policies** with role gates, claim predicates, and field
  groups.
- **Freshness and provenance evidence** for every field it returns.
- **Native actions** for records that Relate owns, with idempotent, actor-bound
  receipts.

---

## Running Relate

Relate is not yet published for application use. Run it from a checkout of the
[repository](https://github.com/relatehq/relate):

```sh
pnpm install
pnpm example:hello-world
```

The [hello-world example](../../../examples/hello-world) defines a source and
object, adopts a record, and performs an authorized read using an in-memory
store. No database or credentials are needed.

---

## Tutorial: Building Your First Graph

This walkthrough models a customer directory, applies region-based access
control, starts an in-memory runtime, and performs an authorized read.

### 1. Define the Source

Sources describe existing systems of record. Each system keeps ownership of its
records.

```ts
import { z } from 'zod';
import { defineSource } from 'relate';

export const customerSource = defineSource({
  id: 'crm.customers',
  idField: 'id',
  schema: z.object({
    id: z.string(),
    name: z.string(),
    region: z.string(),
    status: z.string(),
  }),
});
```

- `id`: A stable identifier for this source across refactors.
- `idField`: The field in `schema` that holds the source's own record key.
- `schema`: A Zod object schema describing the raw record. Mapped fields must be
  plain strings, numbers, or booleans.

### 2. Define the Graph Object

Objects expose typed entities to applications. Each object has an object ID,
presentation labels, a membership source, and mapped properties.

```ts
import { defineObject, from, objectId, source } from 'relate';

export const Customer = defineObject({
  id: 'customer',
  label: 'Customer',
  pluralLabel: 'Customers',
  description: 'Customer accounts from the CRM.',
  membership: source(customerSource),
  properties: {
    id: objectId({ id: 'customer.id' }),
    name: from(customerSource.fields.name, { id: 'customer.name' }),
    region: from(customerSource.fields.region, { id: 'customer.region' }),
    status: from(customerSource.fields.status, { id: 'customer.status' }),
  },
});
```

- `objectId`: Declares the object ID property. Relate generates object IDs when
  it adopts a source record; they are not the source's keys.
- `from`: Maps an object property to a source field, with its type inferred from
  the source schema.

### 3. Define Access Rules and the Graph

Access is declarative. You declare roles, field groups, and principal claims,
then give every object a read policy.

```ts
import { z } from 'zod';
import { defineAccess, defineGraph } from 'relate';
import { Customer } from './customer.js';

export const access = defineAccess({
  roles: ['sales', 'support'],
  fieldGroups: ['ordinary'],
  claims: {
    region: z.string(),
  },
});

export const graph = defineGraph({
  id: 'business',
  objects: { Customer },
  access,
  policies: {
    Customer: {
      read: {
        // Only principals with the 'sales' role can read Customer records.
        gate: access.role('sales'),
        // Principals only see customers in their own region.
        where: { region: { eq: access.claims.region } },
        // The region check must use source evidence at most 30 seconds old.
        evidenceMaxAgeMs: 30_000,
      },
    },
  },
});
```

A gate names exactly one role. `where` and `evidenceMaxAgeMs` are set together;
a rule with only a `gate` is also valid.

### 4. Read from Your Application

Use `@relate/node` to create a runtime, adopt a source record, and read it as a
caller:

```ts
import { z } from 'zod';
import { createRuntime } from '@relate/node';
import { connect } from 'relate';
import { customerSource } from './source.js';
import { Customer } from './customer.js';
import { graph } from './graph.js';

// Stands in for your CRM API.
const crm: Record<string, z.infer<typeof customerSource.schema>> = {
  cust_101: {
    id: 'cust_101',
    name: 'Acme Corp',
    region: 'emea',
    status: 'active',
  },
  cust_102: {
    id: 'cust_102',
    name: 'Globex',
    region: 'apac',
    status: 'active',
  },
};

const relate = createRuntime({
  graph,
  graphId: 'my-app',
  connections: [
    connect(customerSource, {
      providerAccountId: 'crm-prod',
      connectionId: 'crm-main',
      connector: {
        identify: async () => 'crm-prod',
        async fetch(sourceRecordId) {
          const record = crm[sourceRecordId];
          return record
            ? { providerAccountId: 'crm-prod', state: 'present', record }
            : { providerAccountId: 'crm-prod', state: 'deleted' };
        },
      },
    }),
  ],
});

try {
  // Adoption gives a source record its Relate object ID.
  const acme = await relate.host.adopt(Customer, 'cust_101');

  // Scope operations to an authenticated caller.
  const { objects } = relate.as({
    id: 'ana',
    roles: ['sales'],
    claims: { region: 'emea' },
  });

  const result = await objects.Customer.get(acme, {
    select: ['name', 'status'],
  });

  if (result.status === 'ok') {
    console.log(result.data);
    // { name: 'Acme Corp', status: 'active' }

    console.log(result.meta.fields.name);
    // { status: 'available', freshness: 'fresh', observedAt: '…', source: 'source', … }
  }
} finally {
  await relate.close();
}
```

`get` returns `{ status: 'not-found' }` or `{ status: 'ok', id, data, meta }`.
`data` holds only the selected properties, and each one stays optional because a
read can withhold a field. `meta.fields` reports, per field, whether it was
available, forbidden, or unavailable, how fresh it is, and where it came from.
Use `assertFields(result, ['name'])` when your code requires a field.

If Ana reads the adopted `cust_102` customer in `'apac'`, the result is
`{ status: 'not-found' }`. A record the caller may not read looks the same as
one that does not exist.

---

## Next Steps

- **[Key Concepts](./key-concepts.md)**: The main authoring concepts and how
  sources, objects, policies, actions, and apps fit together.
- **[Architecture Overview](./overview.md)**: How Relate handles source
  ownership, object identity, and evidence.
- **[Graph Modeling](./authoring/graph.md)**: Sources, objects, references, and
  relationships.
- **[Access Control](./authoring/access-control.md)**: Role gates, claim
  predicates, and field groups.
- **[Reading Data](./runtime/reading-data.md)**: Reads, property selection, and
  relationship traversal.
- **[Actions & Mutations](./runtime/actions.md)**: Native actions, declared
  business failures, and receipts.
- **[Postgres Persistence](./deployment/postgres.md)**: Running with a durable
  Postgres store.
