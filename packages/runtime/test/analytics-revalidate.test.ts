import { expect, it } from 'vitest';
import { compile } from 'relate/compiler';
import { createAnalyticalGraph } from '../../../tests/support/analytical-graph.js';
import { actorAssociations } from '../src/authorization/index.js';
import { revalidateFields } from '../src/analytics/revalidate.js';
import type {
  AuthorizedCandidate,
  ComputedField,
} from '../src/analytics/execution-types.js';

function fixture() {
  const { manifest } = compile(createAnalyticalGraph().graph);
  const principal = {
    id: 'ana',
    roles: ['reader', 'analyst', 'private'],
    claims: {},
  };
  const scope = actorAssociations(manifest, principal, manifest.objects[0]!);
  const dependency = (value: string) => ({
    value: { type: 'string', value } as const,
    evidence: {
      status: 'available',
      source: 'native',
      freshness: 'fresh',
      observedAt: '2026-10-21T00:00:00.000Z',
      retention: 'confirmed',
      retentionDurability: 'volatile',
      ordering: 'confirmed',
      refresh: 'not-needed',
    } as const,
  });
  const candidate: AuthorizedCandidate = {
    id: 'customer-1',
    dependencies: {
      'customer.external': dependency('key'),
      'customer.label': dependency('label'),
    },
  };
  const field = (
    dependencies: AuthorizedCandidate['dependencies'],
  ): ComputedField => ({
    status: 'available',
    value: '7',
    computedAt: '2026-10-21T00:00:00.000Z',
    columns: ['events.customer', 'events.amount'],
    input: {
      associationId: 'customer.events',
      datasetId: 'events',
      bindingRevision: 'binding',
      readAt: '2026-10-21T00:00:00.000Z',
    },
    dependencies: structuredClone(dependencies),
  });

  return {
    scope,
    candidate,
    fields: {
      count: field({
        'customer.external': candidate.dependencies['customer.external']!,
      }),
      caller: field(candidate.dependencies),
    },
    withoutAssociation: () =>
      actorAssociations(
        manifest,
        { ...principal, roles: ['reader', 'private'] },
        manifest.objects[0]!,
      ),
  };
}

it('withholds both calculation forms when the association gate is revoked without disclosing its identity', () => {
  const { fields, candidate, withoutAssociation } = fixture();
  const result = revalidateFields(fields, candidate, withoutAssociation());

  expect(result).toEqual({
    count: { status: 'forbidden' },
    caller: { status: 'forbidden' },
  });
  expect(JSON.stringify(result)).not.toMatch(/events|binding|7/);
});

it.each(['events.amount', 'events.customer'])(
  'withholds both calculation forms when column %s is revoked',
  (id) => {
    const { fields, candidate, scope } = fixture();
    const changed = {
      ...scope,
      associations: scope.associations.map((association) => ({
        ...association,
        columns: association.columns.map((column) =>
          column.id === id ? { ...column, readable: false } : column,
        ),
      })),
    };

    expect(revalidateFields(fields, candidate, changed)).toEqual({
      count: { status: 'forbidden' },
      caller: { status: 'forbidden' },
    });
  },
);

it.each([
  ['customer.count', 'count', 'forbidden'],
  ['customer.label', 'caller', 'forbidden'],
  ['customer.external', 'both', 'unavailable'],
] as const)(
  'applies revocation of property %s only to dependent calculations',
  (id, target, status) => {
    const { fields, candidate, scope } = fixture();
    const changed = {
      ...scope,
      properties: scope.properties.map((property) =>
        property.id === id ? { ...property, readable: false } : property,
      ),
    };
    const result = revalidateFields(fields, candidate, changed);
    const withheld =
      status === 'forbidden'
        ? { status }
        : { status, reason: 'correlation-unavailable' };

    for (const name of ['count', 'caller'] as const) {
      expect(result[name]).toEqual(
        target === 'both' || target === name ? withheld : fields[name],
      );
    }
  },
);

for (const id of ['customer.external', 'customer.label']) {
  it.each(['missing', 'changed', 'null', 'unavailable'] as const)(
    'invalidates %s dependency ' +
      id +
      ' without recomputing or poisoning independent fields',
    (change) => {
      const { fields, candidate, scope } = fixture();
      const dependencies = { ...candidate.dependencies };

      if (change === 'missing') delete dependencies[id];
      else if (change === 'unavailable')
        dependencies[id] = {
          evidence: { status: 'unavailable' },
        };
      else
        dependencies[id] = {
          ...dependencies[id]!,
          value: {
            type: 'string',
            value: change === 'null' ? null : 'changed',
          },
        };

      const result = revalidateFields(
        fields,
        { ...candidate, dependencies },
        scope,
      );
      const withheld = {
        status: 'unavailable',
        reason: 'correlation-unavailable',
      };

      expect(result.caller).toEqual(withheld);
      expect(result.count).toEqual(
        id === 'customer.external' ? withheld : fields.count,
      );
      expect(revalidateFields(result, candidate, scope)).toEqual(result);
    },
  );
}

it('keeps unchanged usable values and detaches the replacement evidence', () => {
  const { fields, candidate, scope } = fixture();
  const result = revalidateFields(fields, candidate, scope);

  expect(result).toEqual(fields);

  for (const name of ['count', 'caller'] as const) {
    const field = result[name]!;

    expect(field.status).toBe('available');

    if (field.status === 'available')
      expect(field.dependencies['customer.external']).not.toBe(
        candidate.dependencies['customer.external'],
      );
  }
});
