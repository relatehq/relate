import { expect, it } from 'vitest';
import { z } from 'zod';
import { compile } from 'relate/compiler';
import { validateManifest } from 'relate/model';
import {
  computed,
  defineAccess,
  defineDataset,
  defineGraph,
  defineObject,
  native,
  nativeMembership,
  objectId,
} from 'relate';
import type { GraphDefinition } from 'relate';

function setup(sql = 'SELECT COUNT(*) FROM self.events') {
  const access = defineAccess({
    roles: ['reader'],
    fieldGroups: ['ordinary', 'sensitive'],
    claims: { amount: z.string() },
  });
  const Events = defineDataset({
    id: 'events',
    columns: {
      customerId: {
        id: 'events.customer',
        schema: z.string(),
        access: access.groups.ordinary,
      },
    },
  });
  const Customer = defineObject({
    id: 'customer',
    membership: nativeMembership(),
    properties: {
      id: objectId({ id: 'customer.id' }),
      name: native(z.string(), { id: 'customer.name' }),
      loginCount: computed({
        id: 'customer.logins',
        sql,
        description: 'All recorded logins.',
        access: access.groups.sensitive,
      }),
    },
    datasets: {
      events: {
        id: 'customer.events',
        dataset: Events,
        on: [{ column: 'customerId', property: 'id' }],
      },
    },
  });
  const graph = defineGraph({
    id: 'graph',
    access,
    datasets: { Events },
    objects: { Customer },
    policies: {
      Events: {},
      Customer: {
        read: { gate: access.role('reader') },
        groups: { sensitive: access.role('reader') },
        datasets: { events: { gate: access.role('reader') } },
      },
    },
  });

  return { graph, Customer, Events, access };
}

it('compiles declaration identity and SQL separately from stored properties', () => {
  const { graph, Customer } = setup();
  const { manifest } = compile(graph);
  const object = manifest.objects[0]!;

  expect(object.properties.map((p) => p.name)).toEqual(['id', 'name']);
  expect(object.calculations).toEqual([
    {
      id: 'customer.logins',
      name: 'loginCount',
      sql: 'SELECT COUNT(*) FROM self.events',
      description: 'All recorded logins.',
      access: 'sensitive',
    },
  ]);
  expect(Object.isFrozen(Customer.properties.loginCount)).toBe(true);
  expect(Object.isFrozen(Customer.properties.loginCount.origin)).toBe(true);
  expect(Object.isFrozen(object.calculations![0])).toBe(true);
  expect(validateManifest(JSON.parse(JSON.stringify(manifest)))).toEqual(
    manifest,
  );
});

it('changes the revision when SQL changes while preserving the stable property ID', () => {
  const before = compile(setup().graph);
  const after = compile(
    setup('SELECT COUNT(DISTINCT customerId) FROM self.events').graph,
  );

  expect(after.manifest.objects[0]!.calculations![0]!.id).toBe(
    before.manifest.objects[0]!.calculations![0]!.id,
  );
  expect(after.definitionRevision).not.toBe(before.definitionRevision);
});

it('preserves declared identity on a property rename and omits absent descriptions', () => {
  const { graph, Customer } = setup();
  const { loginCount, ...properties } = Customer.properties;
  const renamed = {
    ...graph,
    objects: {
      Customer: {
        ...Customer,
        properties: {
          ...properties,
          logins: computed({ id: loginCount.id, sql: loginCount.origin.sql }),
        },
      },
    },
  };
  const result = compile(renamed).manifest.objects[0]!.calculations![0]!;

  expect(result).toEqual({
    id: 'customer.logins',
    name: 'logins',
    sql: loginCount.origin.sql,
    access: 'ordinary',
  });
});

it.each(['', ' ', undefined, null, 42])(
  'rejects missing or blank SQL %j',
  (sql) => {
    expect(() => computed({ id: 'bad', sql } as never)).toThrow(
      'computed property requires SQL',
    );
  },
);
it.each(['params', 'schema', 'default', 'from'])(
  'rejects an unsupported authoring option %s',
  (name) => {
    expect(() =>
      computed({
        id: 'bad',
        sql: 'SELECT COUNT(*) FROM self.events',
        [name]: {},
      } as never),
    ).toThrow('accepts only');
  },
);

it('does not parse SQL in the portable compiler; startup owns semantic validation', () => {
  const { graph } = setup('not valid SQL');

  expect(compile(graph).manifest.objects[0]!.calculations![0]!.sql).toBe(
    'not valid SQL',
  );
});

it('forbids calculated correlations and policy dependencies', () => {
  const { graph, Customer, access } = setup();
  const correlation = {
    ...graph,
    objects: {
      Customer: {
        ...Customer,
        datasets: {
          events: {
            ...Customer.datasets!.events,
            on: [{ column: 'customerId', property: 'loginCount' }],
          },
        },
      },
    },
  };

  expect(() => compile(correlation as unknown as GraphDefinition)).toThrow(
    'Correlation requires',
  );
  const policy = {
    ...graph,
    policies: {
      ...graph.policies,
      Customer: {
        ...graph.policies.Customer,
        read: {
          gate: access.role('reader'),
          evidenceMaxAgeMs: 0,
          where: { loginCount: { eq: access.claims.amount } },
        },
      },
    },
  };

  expect(() => compile(policy as unknown as GraphDefinition)).toThrow(
    'Policies cannot depend on computed',
  );
});

it('validates calculated property names, IDs and access groups in loaded manifests', () => {
  const model = compile(setup().graph);
  const mutate = (
    change: (
      entry: NonNullable<
        (typeof model.manifest.objects)[0]['calculations']
      >[number],
    ) => void,
  ) => {
    const manifest = structuredClone(model.manifest);

    change(manifest.objects[0]!.calculations![0]!);

    return manifest;
  };

  expect(() =>
    validateManifest(
      mutate((p) => {
        p.id = 'customer.name';
      }),
    ),
  ).toThrow('duplicate definition ID');
  expect(() =>
    validateManifest(
      mutate((p) => {
        p.name = 'Name';
      }),
    ),
  ).toThrow('Names collide');
  expect(() =>
    validateManifest(
      mutate((p) => {
        p.access = 'unknown';
      }),
    ),
  ).toThrow('Unknown calculated property field group');
  expect(() =>
    validateManifest(
      mutate((p) => {
        p.sql = ' ';
      }),
    ),
  ).toThrow('Description must not be blank');
});
