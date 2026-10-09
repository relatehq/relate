# Access Control & Security

In Relate, access control is **declarative**, **non-leaking**, and evaluated by
the runtime on every read, traversal, and action.

Instead of authorization filters scattered across service endpoints, policies
are part of the graph definition and compiled into its manifest. The host
authenticates each caller and supplies their roles and claims; Relate decides
what that principal may see or do.

---

## Declaring Roles, Field Groups, and Claims

Use `defineAccess` to declare the vocabulary your policies use:

```ts
// access.ts
import { z } from 'zod';
import { defineAccess } from 'relate';

export const access = defineAccess({
  // Roles the host may assign to an authenticated principal.
  roles: ['employee', 'finance', 'account-manager'],
  // Sensitivity groups for properties. `ordinary` is the default group.
  fieldGroups: ['ordinary', 'financial'],
  // Attributes the host supplies for each principal.
  claims: { portfolio: z.string() },
});
```

This returns helpers used in definitions and policies:

- `access.role(name)`: a role gate for exactly one role.
- `access.groups.<name>`: a field group to assign to properties.
- `access.claims.<name>`: a claim to compare against property values.
- `access.actor.id`: the calling principal's ID.

---

## Assigning Properties to Field Groups

Each property can name the field group it belongs to:

```ts
// model.ts (excerpt)
import { z } from 'zod';
import { defineObject, defineSource, from, objectId, source } from 'relate';
import { access } from './access.js';

const { ordinary, financial } = access.groups;

export const crmCustomers = defineSource({
  id: 'crm.customers',
  idField: 'id',
  schema: z.object({
    id: z.string(),
    display_name: z.string(),
    portfolio: z.string(),
    status: z.string(),
    revenue: z.number(),
  }),
});

export const Customer = defineObject({
  id: 'business.customer',
  label: 'Customer',
  membership: source(crmCustomers),
  properties: {
    id: objectId({ id: 'business.customer.key', access: ordinary }),
    name: from(crmCustomers.fields.display_name, {
      id: 'business.customer.name',
      access: ordinary,
    }),
    portfolio: from(crmCustomers.fields.portfolio, {
      id: 'business.customer.portfolio',
      access: ordinary,
    }),
    status: from(crmCustomers.fields.status, {
      id: 'business.customer.status',
      access: ordinary,
    }),
    revenue: from(crmCustomers.fields.revenue, {
      id: 'business.customer.revenue',
      access: financial,
    }),
  },
});
```

Every object needs exactly one `objectId()` property, and `from(...)` fields
must come from the object's membership source.

---

## Attaching Policies to Objects

`defineGraph` requires an explicit policy for every object under `policies`:

```ts
// graph.ts
import { defineGraph } from 'relate';
import { access } from './access.js';
import { AccountReview, Customer, CustomerInvoices, Invoice } from './model.js';

export const graph = defineGraph({
  id: 'business.graph',
  objects: { Customer, Invoice, AccountReview },
  relationships: { CustomerInvoices },
  access,
  policies: {
    Customer: {
      read: {
        // Role gate: the caller must hold `employee`.
        gate: access.role('employee'),
        // Claim predicate: only customers in the caller's portfolio.
        where: { portfolio: { eq: access.claims.portfolio } },
        // Maximum age of the evidence used to evaluate `where`.
        evidenceMaxAgeMs: 30_000,
      },
      // Fields in the `financial` group also require `finance`.
      groups: { financial: access.role('finance') },
    },
    Invoice: {
      read: {
        gate: access.role('employee'),
        // Predicates can follow references to other objects.
        where: { customer: { portfolio: { eq: access.claims.portfolio } } },
        evidenceMaxAgeMs: 30_000,
      },
      groups: { financial: access.role('finance') },
    },
    // Relate-owned objects can also have a `create` rule.
    AccountReview: {
      read: {
        gate: access.role('employee'),
        where: { customer: { portfolio: { eq: access.claims.portfolio } } },
        evidenceMaxAgeMs: 30_000,
      },
      create: {
        gate: access.role('account-manager'),
        where: {
          customer: { portfolio: { eq: access.claims.portfolio } },
          author: { eq: access.actor.id },
        },
        evidenceMaxAgeMs: 30_000,
      },
    },
  },
});
```

`Invoice`, `AccountReview`, and `CustomerInvoices` are defined in
[Graph Modeling](./graph.md). A complete version of this graph, including
actions, is in
[`dev/fixtures/customer-graph`](../../../../dev/fixtures/customer-graph/source/graph.ts).

---

## Policy Mechanics

### 1. Role Gates (`gate`)

A gate names a single role. If the caller does not hold that role, the object is
denied. To let several kinds of user read an object, give those principals a
shared role such as `employee`.

### 2. Claim Predicates (`where`)

Predicates compare property values with the caller's claims or actor ID:

```ts
where: {
  portfolio: {
    eq: access.claims.portfolio;
  }
}
```

They can also follow references:

```ts
where: {
  customer: {
    portfolio: {
      eq: access.claims.portfolio;
    }
  }
}
```

A rule is either a gate alone, or a gate with both `where` and
`evidenceMaxAgeMs`; the two must be set together.

If a record fails the gate or the predicate, Relate behaves as if it does not
exist. A direct read returns `{ status: 'not-found' }`, and traversals leave the
record out. A denied record is indistinguishable from a missing one.

### 3. Field Groups (`groups`)

When a caller can read an object but lacks the role for one of its field groups,
the read still succeeds. Fields in that group are left out of `data`, and their
evidence reports them as forbidden:

```ts
const result = await objects.Customer.get(id, {
  select: ['name', 'revenue'],
});
// For an `employee` without `finance`:
// result.data          → { name: 'Northwind' }
// result.meta.fields   → { revenue: { status: 'forbidden' } } (compact default)
// result.meta.completeness → 'partial'
```

The caller learns only that it lacks access to the field, not why, and you don't
need separate DTOs for each role. The `ordinary` group has no gate beyond the
object's read rule.

### 4. Evidence Age (`evidenceMaxAgeMs`)

Policy decisions can depend on source data that changes, such as a customer
moving to another portfolio. If the stored observation used to evaluate `where`
is older than `evidenceMaxAgeMs`, Relate fetches the record from its source
again before deciding.

This limits the age of **permission evidence** only. The age of returned data is
controlled separately by the read's `maxAgeMs` option (default 60 seconds); see
[Querying & Traversal](../runtime/reading-data.md#evidence-and-freshness).

### 5. Create Rules (`create`)

`create` rules apply only to objects with `nativeMembership()`, which Relate
owns and actions write. They are checked against the values an action creates,
so the `AccountReview` rule above only accepts reviews for customers in the
caller's portfolio, authored by the caller. Source-backed objects such as
`Customer` cannot have a `create` rule. See
[Actions, Mutations & Receipts](../runtime/actions.md).
