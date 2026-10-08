import { expect, it } from 'vitest';
import { z } from 'zod';
import {
  CompileError,
  defineAccess,
  defineGraph,
  defineObject,
  defineRelationship,
  defineSource,
  definitionProvenance,
  disableDefinitionProvenance,
  enableDefinitionProvenance,
  from,
  native,
  nativeMembership,
  objectId,
  reference,
  source,
} from 'relate';
import { compile } from 'relate/compiler';
import { ManifestValidationError, validateManifest } from 'relate/model';
import type { ModelIssue } from 'relate/diagnostics';
import {
  formatIssuePath,
  normalizeIssues,
  CompileError as DiagnosticsCompileError,
} from 'relate/diagnostics';

const access = defineAccess({
  roles: ['reader', 'finance'],
  fieldGroups: ['ordinary', 'financial'],
  claims: { portfolio: z.string() },
});

const customers = defineSource({
  id: 'crm.customers',
  idField: 'id',
  schema: z.object({ id: z.string(), name: z.string(), portfolio: z.string() }),
});

const invoices = defineSource({
  id: 'billing.invoices',
  idField: 'id',
  schema: z.object({ id: z.string(), customer_id: z.string() }),
});

const Customer = defineObject({
  id: 'example.customer',
  membership: source(customers),
  properties: {
    id: objectId({ id: 'example.customer.id' }),
    name: from(customers.fields.name, { id: 'example.customer.name' }),
    portfolio: from(customers.fields.portfolio, {
      id: 'example.customer.portfolio',
    }),
  },
});

const Invoice = defineObject({
  id: 'example.invoice',
  membership: source(invoices),
  properties: {
    id: objectId({ id: 'example.invoice.id' }),
    customer: reference(Customer, {
      id: 'example.invoice.customer',
      from: invoices.fields.customer_id,
    }),
  },
});

const AccountReview = defineObject({
  id: 'example.account-review',
  membership: nativeMembership(),
  properties: {
    id: objectId({ id: 'example.account-review.id' }),
    customer: reference(Customer, { id: 'example.account-review.customer' }),
    note: native(z.string(), { id: 'example.account-review.note' }),
  },
});

const CustomerInvoices = defineRelationship({
  id: 'example.customer-invoices',
  forward: 'invoices',
  reverse: 'customer',
  via: Invoice.properties.customer,
});

const CustomerReviews = defineRelationship({
  id: 'example.customer-reviews',
  forward: 'reviews',
  reverse: 'customer',
  via: AccountReview.properties.customer,
});

const graph = defineGraph({
  id: 'example',
  objects: { Customer, Invoice, AccountReview },
  relationships: { CustomerInvoices, CustomerReviews },
  access,
  policies: {
    Customer: { read: { gate: access.role('reader') } },
    Invoice: { read: { gate: access.role('reader') } },
    AccountReview: { read: { gate: access.role('reader') } },
  },
});

function issuesOf(run: () => unknown): readonly ModelIssue[] {
  try {
    run();
  } catch (error) {
    if (
      error instanceof CompileError ||
      error instanceof ManifestValidationError
    )
      return error.issues;

    throw error;
  }

  throw new Error('Expected a structured validation error');
}

it('shares one CompileError class between relate and relate/diagnostics', () => {
  expect(DiagnosticsCompileError).toBe(CompileError);
  expect(() => new CompileError([])).toThrow('needs an issue');
  const error = new CompileError([
    { code: 'policy.missing', message: 'second' },
    { code: 'graph.invalid-shape', message: 'first' },
  ]);

  expect(error.name).toBe('CompileError');
  expect(error.message).toBe('first\nsecond');
  expect(Object.isFrozen(error.issues)).toBe(true);
  expect(JSON.parse(JSON.stringify(error.issues))).toEqual(error.issues);
});

it('reports an unknown policy role with a stable code, the object ID and the authored gate path', () => {
  const issues = issuesOf(() =>
    compile({
      ...graph,
      policies: {
        ...graph.policies,
        Invoice: { read: { gate: { kind: 'role', role: 'finanse' } } },
      },
    } as never),
  );

  expect(issues).toEqual([
    {
      code: 'policy.unknown-role',
      message: "Unknown policy role 'finanse' in policy Invoice.read",
      definitionId: 'example.invoice',
      path: {
        root: 'graph',
        segments: ['policies', 'Invoice', 'read', 'gate'],
      },
    },
  ]);
  expect(formatIssuePath(issues[0]!.path!)).toBe(
    'graph.policies.Invoice.read.gate',
  );
});

it('identifies unregistered relationship endpoints and reference targets by definition', () => {
  const detached = defineObject({ ...Invoice });
  const issues = issuesOf(() =>
    compile({
      ...graph,
      relationships: {
        ...graph.relationships,
        CustomerInvoices: { ...CustomerInvoices, to: detached },
      },
    }),
  );

  expect(issues).toEqual([
    {
      code: 'relationship.invalid-endpoints',
      message:
        "Unregistered relationship endpoint or reference: relationship CustomerInvoices ('example.customer-invoices') connects 'example.customer' to 'example.invoice' via 'example.invoice.customer'",
      definitionId: 'example.customer-invoices',
      path: { root: 'graph', segments: ['relationships', 'CustomerInvoices'] },
    },
  ]);

  const orphanCustomer = defineObject({ ...Customer });
  const review = defineObject({
    ...AccountReview,
    properties: {
      ...AccountReview.properties,
      customer: reference(orphanCustomer, {
        id: AccountReview.properties.customer.id,
      }),
    },
  });
  const referenceIssues = issuesOf(() =>
    compile({
      ...graph,
      objects: { ...graph.objects, AccountReview: review },
      relationships: {
        CustomerInvoices,
        CustomerReviews: defineRelationship({
          id: CustomerReviews.id,
          forward: 'reviews',
          reverse: 'customer',
          via: review.properties.customer,
        }),
      },
    }),
  );

  // The relationship binds the orphan copy, not the registered Customer.
  expect(referenceIssues.map((issue) => issue.code)).toEqual([
    'relationship.invalid-endpoints',
  ]);

  const Other = defineObject({ ...Customer, id: 'example.other-customer' });
  const reviewOfOther = defineObject({
    ...AccountReview,
    properties: {
      ...AccountReview.properties,
      customer: reference(Other, { id: AccountReview.properties.customer.id }),
    },
  });
  const unregisteredTarget = issuesOf(() =>
    compile({
      ...graph,
      objects: { ...graph.objects, AccountReview: reviewOfOther },
      relationships: { CustomerInvoices },
    }),
  );

  expect(unregisteredTarget).toEqual([
    {
      code: 'reference.invalid-target',
      message:
        "Property AccountReview.customer references unregistered object 'example.other-customer'",
      definitionId: 'example.account-review',
      path: {
        root: 'graph',
        segments: ['objects', 'AccountReview', 'properties', 'customer'],
      },
    },
  ]);
});

it('requires exactly one objectId() during authoring with a definition-relative path', () => {
  const { id, ...properties } = Customer.properties;

  void id;
  const issues = issuesOf(() => defineObject({ ...Customer, properties }));

  expect(issues).toEqual([
    {
      code: 'object.object-id-count',
      message:
        "Object 'example.customer' requires exactly one objectId() property; found 0",
      definitionId: 'example.customer',
      path: { root: 'definition', segments: ['properties'] },
    },
  ]);
  // Bypassing defineObject still produces the same code at the graph path.
  expect(
    issuesOf(() =>
      compile({
        ...graph,
        objects: { ...graph.objects, Customer: { ...Customer, properties } },
        // Relationships hold the original Customer; a copy would also fail them.
        relationships: {},
      }),
    ),
  ).toMatchObject([
    {
      code: 'object.object-id-count',
      definitionId: 'example.customer',
      path: { root: 'graph', segments: ['objects', 'Customer', 'properties'] },
    },
  ]);
});

it('aggregates independent mistakes in deterministic order without cascades', () => {
  const detached = defineObject({ ...Customer });
  const issues = issuesOf(() =>
    compile({
      ...graph,
      policies: {
        ...graph.policies,
        Invoice: { read: { gate: { kind: 'role', role: 'finanse' } } },
      },
      relationships: {
        ...graph.relationships,
        CustomerReviews: { ...CustomerReviews, from: detached },
      },
    } as never),
  );

  expect(issues.map((issue) => [issue.code, issue.path?.segments])).toEqual([
    ['policy.unknown-role', ['policies', 'Invoice', 'read', 'gate']],
    ['relationship.invalid-endpoints', ['relationships', 'CustomerReviews']],
  ]);

  // An unknown policy object skips the dependent role check instead of
  // reporting a second fabricated issue for the same mistake.
  const unknownObject = issuesOf(() =>
    compile({
      ...graph,
      policies: {
        ...graph.policies,
        Missing: { read: { gate: { kind: 'role', role: 'nobody' } } },
      },
    } as never),
  );

  expect(unknownObject).toEqual([
    {
      code: 'policy.unknown-object',
      message: "Unknown policy object 'Missing'",
      path: { root: 'graph', segments: ['policies', 'Missing'] },
    },
  ]);
});

it('reports manifest issues with manifest paths and translates them to authored paths during compilation', () => {
  const manifest = structuredClone(compile(graph).manifest);
  const customer = manifest.objects.findIndex((o) => o.id === Customer.id);
  const name = manifest.objects[customer]!.properties.findIndex(
    (p) => p.name === 'name',
  );

  manifest.policies[Invoice.id]!.read.role = 'finanse';
  manifest.objects[customer]!.properties[name]!.access = 'financal';
  const issues = issuesOf(() => validateManifest(manifest));

  expect(issues).toEqual([
    {
      code: 'property.unknown-field-group',
      message: "Unknown field group 'financal' on property Customer.name",
      definitionId: 'example.customer',
      path: {
        root: 'manifest',
        segments: ['objects', customer, 'properties', name, 'access'],
      },
    },
    {
      code: 'policy.unknown-role',
      message: "Unknown policy role 'finanse' in policy Invoice.read",
      definitionId: 'example.invoice',
      path: {
        root: 'manifest',
        segments: ['policies', 'example.invoice', 'read', 'role'],
      },
    },
  ]);

  const shape = issuesOf(() => validateManifest({ formatVersion: 2 }));

  expect(shape.length).toBeGreaterThan(1);
  expect(shape.every((issue) => issue.code === 'manifest.invalid-shape')).toBe(
    true,
  );
  expect(shape[0]!.path!.root).toBe('manifest');
  expect(shape.some((issue) => issue.message.includes('formatVersion'))).toBe(
    true,
  );
});

it('keeps manifest-rooted paths when a lowered path has no authored counterpart', () => {
  const manifest = structuredClone(compile(graph).manifest);

  manifest.sources[0]!.fields[manifest.sources[0]!.idField] = {
    type: 'number',
    optional: false,
    nullable: false,
  };
  const issues = issuesOf(() => validateManifest(manifest));

  expect(issues.map((issue) => issue.code)).toContain(
    'source.invalid-id-field',
  );
  expect(issues[0]!.path).toEqual({
    root: 'manifest',
    segments: ['sources', 0, 'idField'],
  });
});

it('normalizes duplicate issues and orders them by path then code', () => {
  const issue: ModelIssue = {
    code: 'policy.missing',
    message: 'Missing policy: Customer',
    path: { root: 'graph', segments: ['policies', 'Customer'] },
  };

  expect(
    normalizeIssues([
      issue,
      { ...issue },
      {
        code: 'graph.invalid-shape',
        message: 'first',
        path: { root: 'graph', segments: [] },
      },
      {
        code: 'policy.unknown-role',
        message: 'nested',
        path: { root: 'graph', segments: ['policies', 'Customer', 'read'] },
      },
    ]).map((entry) => entry.code),
  ).toEqual(['graph.invalid-shape', 'policy.missing', 'policy.unknown-role']);
});

it('captures declaration provenance only when enabled and never changes the revision', () => {
  const build = () => {
    const people = defineSource({
      id: 'provenance.people',
      idField: 'id',
      schema: z.object({ id: z.string(), name: z.string() }),
    });
    const Person = defineObject({
      id: 'provenance.person',
      membership: source(people),
      properties: {
        id: objectId({ id: 'provenance.person.id' }),
        name: from(people.fields.name, { id: 'provenance.person.name' }),
      },
    });
    const Note = defineObject({
      id: 'provenance.note',
      membership: nativeMembership(),
      properties: {
        id: objectId({ id: 'provenance.note.id' }),
        person: reference(Person, { id: 'provenance.note.person' }),
      },
    });
    const PersonNotes = defineRelationship({
      id: 'provenance.person-notes',
      forward: 'notes',
      reverse: 'person',
      via: Note.properties.person,
    });
    const graphAccess = defineAccess({
      roles: ['reader'],
      fieldGroups: ['ordinary'],
      claims: {},
    });
    const authored = defineGraph({
      id: 'provenance.graph',
      objects: { Person, Note },
      relationships: { PersonNotes },
      access: graphAccess,
      policies: {
        Person: { read: { gate: graphAccess.role('reader') } },
        Note: { read: { gate: graphAccess.role('reader') } },
      },
    });

    return { people, Person, Note, PersonNotes, authored };
  };
  const plain = build();

  expect(definitionProvenance(plain.Person)).toBeUndefined();
  expect(definitionProvenance(plain.authored)).toBeUndefined();

  enableDefinitionProvenance();

  try {
    const captured = build();

    for (const definition of [
      captured.people,
      captured.Person,
      captured.Note,
      captured.PersonNotes,
      captured.authored,
    ])
      expect(definitionProvenance(definition)).toContain('diagnostics.test.ts');

    expect(compile(captured.authored)).toEqual(compile(plain.authored));
    expect(JSON.stringify(captured.authored)).toBe(
      JSON.stringify(plain.authored),
    );
  } finally {
    disableDefinitionProvenance();
  }

  expect(definitionProvenance(build().Person)).toBeUndefined();
  enableDefinitionProvenance({ capture: () => 'custom-site' });

  try {
    expect(definitionProvenance(build().Person)).toBe('custom-site');
  } finally {
    disableDefinitionProvenance();
  }
});

it('collects unsupported declared and policy claim schemas without losing other issues', () => {
  const brokenAccess = defineAccess({
    roles: ['reader'],
    fieldGroups: ['ordinary'],
    claims: {
      portfolio: z.string().refine(() => true),
      unused: z.string().transform((value) => value),
    },
  });
  const result = issuesOf(() =>
    compile({
      ...graph,
      access: brokenAccess,
      policies: {
        ...graph.policies,
        Customer: {
          read: {
            gate: brokenAccess.role('reader'),
            where: { portfolio: { eq: brokenAccess.claims.portfolio } },
            evidenceMaxAgeMs: 1000,
          },
        },
        AccountReview: { read: { gate: { kind: 'role', role: 'missing' } } },
      },
    }),
  );

  expect(result).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        code: 'schema.unsupported',
        path: { root: 'graph', segments: ['access', 'claims', 'portfolio'] },
      }),
      expect.objectContaining({
        code: 'schema.unsupported',
        path: { root: 'graph', segments: ['access', 'claims', 'unused'] },
      }),
      expect.objectContaining({ code: 'policy.unknown-role' }),
    ]),
  );
  const foreignAccess = defineAccess({
    roles: ['reader'],
    fieldGroups: ['ordinary'],
    claims: { portfolio: z.string().refine(() => true) },
  });

  expect(
    issuesOf(() =>
      compile({
        ...graph,
        policies: {
          ...graph.policies,
          Customer: {
            read: {
              gate: access.role('reader'),
              where: { portfolio: { eq: foreignAccess.claims.portfolio } },
              evidenceMaxAgeMs: 1000,
            },
          },
        },
      }),
    ),
  ).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        code: 'schema.unsupported',
        definitionId: Customer.id,
      }),
    ]),
  );
});

it('reports malformed object entries alongside independent policy errors', () => {
  for (const objects of [
    { Broken: null, ...graph.objects },
    { ...graph.objects, Broken: null },
  ]) {
    const result = issuesOf(() =>
      compile({
        ...graph,
        objects: objects as unknown as typeof graph.objects,
        policies: {
          ...graph.policies,
          Broken: { read: 'deny' },
          Customer: { read: { gate: { kind: 'role', role: 'missing' } } },
        },
      }),
    );

    expect(result).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'graph.invalid-shape',
          path: { root: 'graph', segments: ['objects', 'Broken'] },
        }),
        expect.objectContaining({
          code: 'policy.unknown-role',
          definitionId: Customer.id,
        }),
      ]),
    );
  }
});
