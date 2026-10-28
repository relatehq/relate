import { expect, it } from 'vitest';
import { z } from 'zod';
import {
  defineAccess,
  defineDataset,
  defineGraph,
  defineObject,
  native,
  nativeMembership,
  localDateTime,
  objectId,
  reference,
} from 'relate';
import type { GraphDefinition } from 'relate';
import { compile } from 'relate/compiler';
import { validateManifest } from 'relate/model';
import { CompileError } from 'relate/diagnostics';

function setup() {
  const access = defineAccess({
    roles: ['reader', 'analyst', 'support'],
    fieldGroups: ['ordinary', 'identifying'],
    claims: {},
  });
  const Events = defineDataset({
    id: 'events',
    description: 'One recorded event, including duplicate rows.',
    columns: {
      customerId: {
        id: 'events.customer',
        schema: z.string(),
        access: access.groups.ordinary,
      },
      tenantId: {
        id: 'events.tenant',
        schema: z.string(),
        access: access.groups.ordinary,
      },
      userId: {
        id: 'events.user',
        schema: z.string().nullable(),
        access: access.groups.identifying,
        description: 'User ID; null for an anonymous event.',
      },
      count: {
        id: 'events.count',
        schema: z.int64(),
        access: access.groups.ordinary,
      },
      small: {
        id: 'events.small',
        schema: z.int32(),
        access: access.groups.ordinary,
      },
      amount: {
        id: 'events.amount',
        schema: z.number(),
        access: access.groups.ordinary,
      },
      enabled: {
        id: 'events.enabled',
        schema: z.boolean(),
        access: access.groups.ordinary,
      },
      occurredAt: {
        id: 'events.at',
        schema: z.iso.datetime({ offset: true, precision: 6 }),
        access: access.groups.ordinary,
      },
      day: {
        id: 'events.day',
        schema: z.iso.date(),
        access: access.groups.ordinary,
      },
      settledOn: {
        id: 'events.settledOn',
        schema: z.iso.date().nullable(),
        access: access.groups.ordinary,
      },
    },
  });
  const Customer = defineObject({
    id: 'customer',
    membership: nativeMembership(),
    properties: {
      id: objectId({ id: 'customer.id' }),
      externalId: native(z.string(), { id: 'customer.external' }),
      tenantId: native(z.string(), { id: 'customer.tenant' }),
    },
    datasets: {
      events: {
        id: 'customer.events',
        dataset: Events,
        on: [
          { column: 'customerId', property: 'externalId' },
          { column: 'tenantId', property: 'tenantId' },
        ],
      },
    },
  });
  const graph = defineGraph({
    id: 'graph',
    access,
    objects: { Customer },
    datasets: { Events },
    policies: {
      Customer: {
        read: { gate: access.role('reader') },
        datasets: { events: { gate: access.role('analyst') } },
      },
      Events: { groups: { identifying: access.role('support') } },
    },
  });

  return { access, Events, Customer, graph };
}

function altered(change: (graph: Record<string, any>) => void) {
  // Deliberately exercise erased JavaScript authoring at the compiler boundary.
  const { graph } = setup();
  const input = {
    ...graph,
    objects: {
      Customer: {
        ...graph.objects.Customer,
        properties: { ...graph.objects.Customer.properties },
        datasets: {
          events: {
            ...graph.objects.Customer.datasets!.events,
            on: [...graph.objects.Customer.datasets!.events.on],
          },
        },
      },
    },
    datasets: { ...graph.datasets },
    policies: {
      Customer: {
        ...graph.policies.Customer,
        datasets: { ...graph.policies.Customer.datasets },
      },
      Events: {
        ...graph.policies.Events,
        groups: { ...graph.policies.Events.groups },
      },
    },
  };

  change(input);

  return input as unknown as GraphDefinition;
}

function issues(input: GraphDefinition) {
  try {
    compile(input);
  } catch (error) {
    expect(error).toBeInstanceOf(CompileError);

    return (error as CompileError).issues;
  }

  throw new Error('Expected compilation to fail');
}

it('derives a row schema from column-owned schemas and preserves exact column metadata', () => {
  const { graph, Events } = setup();
  const model = compile(graph);
  const dataset = model.manifest.datasets![0]!;

  expect(Events.schema.shape.count).toBe(Events.columns.count.schema);
  expect(Events.schema.shape.userId.safeParse(null).success).toBe(true);
  expect(Events.schema.shape.count.parse(9007199254740993n)).toBe(
    9007199254740993n,
  );
  expect(dataset.description).toBe(Events.description);
  expect(dataset.columns.find((c) => c.name === 'userId')).toEqual({
    id: 'events.user',
    name: 'userId',
    description: 'User ID; null for an anonymous event.',
    access: 'identifying',
    schema: { type: 'string', nullable: true },
  });
  expect(
    Object.fromEntries(dataset.columns.map((c) => [c.name, c.schema])),
  ).toEqual({
    customerId: { type: 'string', nullable: false },
    tenantId: { type: 'string', nullable: false },
    userId: { type: 'string', nullable: true },
    count: { type: 'int64', nullable: false },
    small: { type: 'int32', nullable: false },
    amount: { type: 'float64', nullable: false },
    enabled: { type: 'boolean', nullable: false },
    occurredAt: { type: 'timestamp', precision: 6, nullable: false },
    day: { type: 'date', nullable: false },
    settledOn: { type: 'date', nullable: true },
  });
  expect(dataset.columns.find((c) => c.name === 'count')).not.toHaveProperty(
    'description',
  );
  expect(dataset.groups).toEqual({ identifying: { role: 'support' } });
  expect(Object.isFrozen(dataset.columns)).toBe(true);
  expect(validateManifest(JSON.parse(JSON.stringify(model.manifest)))).toEqual(
    model.manifest,
  );
});

it('resolves composite pairs to stable IDs and normalizes their order for revisions', () => {
  const { graph } = setup();
  const model = compile(graph);

  expect(model.manifest.objects[0]!.datasets).toEqual([
    {
      id: 'customer.events',
      name: 'events',
      datasetDefinitionId: 'events',
      on: [
        {
          columnDefinitionId: 'events.customer',
          propertyDefinitionId: 'customer.external',
        },
        {
          columnDefinitionId: 'events.tenant',
          propertyDefinitionId: 'customer.tenant',
        },
      ],
      gate: { role: 'analyst' },
    },
  ]);
  const reordered = altered((g) =>
    g.objects.Customer.datasets.events.on.reverse(),
  );

  expect(compile(reordered).definitionRevision).toBe(model.definitionRevision);
});

it('preserves IDs through dataset/column/association renames and revises the definition', () => {
  const { graph, Events } = setup();
  const { customerId, ...rest } = Events.columns;
  const renamed = defineDataset({
    id: Events.id,
    columns: { customerKey: customerId, ...rest },
  });
  const input = altered((g) => {
    g.datasets = { Activity: renamed };
    g.policies.Activity = g.policies.Events;
    delete g.policies.Events;
    g.objects.Customer.datasets = {
      activity: {
        id: 'customer.events',
        dataset: renamed,
        on: [{ column: 'customerKey', property: 'externalId' }],
      },
    };
    g.policies.Customer.datasets = {
      activity: g.policies.Customer.datasets.events,
    };
  });
  const model = compile(input);

  expect(
    model.manifest.datasets![0]!.columns.find((c) => c.name === 'customerKey')!
      .id,
  ).toBe('events.customer');
  expect(model.manifest.objects[0]!.datasets![0]!.id).toBe('customer.events');
  expect(model.definitionRevision).not.toBe(compile(graph).definitionRevision);
});

it.each([
  [
    'empty pairs',
    (g: any) => {
      g.objects.Customer.datasets.events.on = [];
    },
    'association.invalid-shape',
  ],
  [
    'legacy map',
    (g: any) => {
      g.objects.Customer.datasets.events.on = { customerId: 'externalId' };
    },
    'association.invalid-shape',
  ],
  [
    'unknown column',
    (g: any) => {
      g.objects.Customer.datasets.events.on[0] = {
        column: 'customer_id',
        property: 'externalId',
      };
    },
    'association.invalid-correlation',
  ],
  [
    'unknown property',
    (g: any) => {
      g.objects.Customer.datasets.events.on[0] = {
        column: 'customerId',
        property: 'external_id',
      };
    },
    'association.invalid-correlation',
  ],
  [
    'duplicate column',
    (g: any) => {
      g.objects.Customer.datasets.events.on.push({
        column: 'customerId',
        property: 'tenantId',
      });
    },
    'association.invalid-correlation',
  ],
  [
    'different type',
    (g: any) => {
      g.objects.Customer.datasets.events.on = [
        { column: 'count', property: 'externalId' },
      ];
    },
    'association.invalid-correlation',
  ],
  [
    'float equality',
    (g: any) => {
      g.objects.Customer.properties.value = native(z.number(), {
        id: 'customer.value',
      });
      g.objects.Customer.datasets.events.on = [
        { column: 'amount', property: 'value' },
      ];
    },
    'association.invalid-correlation',
  ],
  [
    'missing association policy',
    (g: any) => {
      delete g.policies.Customer.datasets.events;
    },
    'policy.missing',
  ],
  [
    'extra association policy',
    (g: any) => {
      g.policies.Customer.datasets.unknown =
        g.policies.Customer.datasets.events;
    },
    'policy.unknown-dependency',
  ],
  [
    'missing dataset policy',
    (g: any) => {
      delete g.policies.Events;
    },
    'policy.missing',
  ],
  [
    'missing column group policy',
    (g: any) => {
      g.policies.Events.groups = {};
    },
    'policy.missing',
  ],
  [
    'unknown role',
    (g: any) => {
      g.policies.Events.groups.identifying = { kind: 'role', role: 'unknown' };
    },
    'policy.unknown-role',
  ],
  [
    'ordinary override',
    (g: any) => {
      g.policies.Events.groups.ordinary = g.policies.Events.groups.identifying;
    },
    'policy.invalid-group',
  ],
  [
    'dataset row policy',
    (g: any) => {
      g.policies.Events.read = g.policies.Customer.read;
    },
    'policy.invalid-rule',
  ],
  [
    'association row policy',
    (g: any) => {
      g.policies.Customer.datasets.events.where = {};
    },
    'policy.invalid-rule',
  ],
  [
    'unregistered instance',
    (g: any) => {
      g.objects.Customer.datasets.events.dataset = { ...g.datasets.Events };
    },
    'dataset.unknown',
  ],
  [
    'folded property',
    (g: any) => {
      g.objects.Customer.properties.externalid = native(z.string(), {
        id: 'customer.second',
      });
    },
    'analytics.folded-name-collision',
  ],
  [
    'folded association',
    (g: any) => {
      g.objects.Customer.datasets.Events = {
        ...g.objects.Customer.datasets.events,
        id: 'customer.events2',
      };
      g.policies.Customer.datasets.Events = g.policies.Customer.datasets.events;
    },
    'analytics.folded-name-collision',
  ],
] as const)(
  'rejects %s with a structured compiler diagnostic',
  (_label, change, code) => {
    expect(issues(altered(change))).toEqual(
      expect.arrayContaining([expect.objectContaining({ code })]),
    );
  },
);

it('allows non-unique ordinary keys, object IDs and exact cross-precision instants', () => {
  const input = altered((g) => {
    g.objects.Customer.datasets.events.on = [
      { column: 'customerId', property: 'id' },
      { column: 'tenantId', property: 'id' },
    ];
  });

  expect(compile(input).manifest.objects[0]!.datasets![0]!.on).toHaveLength(2);
  const temporal = altered((g) => {
    g.objects.Customer.properties.since = native(
      z.iso.datetime({ offset: true, precision: 3 }),
      { id: 'customer.since' },
    );
    g.objects.Customer.datasets.events.on = [
      { column: 'occurredAt', property: 'since' },
    ];
  });

  expect(compile(temporal).manifest.objects[0]!.datasets![0]!.on).toEqual([
    { columnDefinitionId: 'events.at', propertyDefinitionId: 'customer.since' },
  ]);
});

// Ordinary properties have no date type, so a date column is never a key.
it.each([
  ['externalId', 'string'],
  ['since', 'timestamp'],
])('rejects a date column correlated with a %s property', (property) => {
  const input = altered((g) => {
    g.objects.Customer.properties.since = native(
      z.iso.datetime({ offset: true, precision: 3 }),
      { id: 'customer.since' },
    );
    g.objects.Customer.datasets.events.on = [{ column: 'day', property }];
  });

  expect(issues(input)).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ code: 'association.invalid-correlation' }),
    ]),
  );
});

it('rejects references and local wall-clock values as correlation keys', () => {
  const input = altered((g) => {
    g.objects.Customer.properties.link = reference(g.objects.Customer, {
      id: 'customer.link',
    });
    g.objects.Customer.datasets.events.on = [
      { column: 'customerId', property: 'link' },
    ];
  });

  expect(issues(input)).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ code: 'association.invalid-correlation' }),
    ]),
  );
  const local = altered((g) => {
    g.objects.Customer.properties.local = native(
      localDateTime({ precision: 'second' }),
      { id: 'customer.local' },
    );
    g.objects.Customer.datasets.events.on = [
      { column: 'occurredAt', property: 'local' },
    ];
  });

  expect(issues(local)).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ code: 'association.invalid-correlation' }),
    ]),
  );
});

it.each([
  [
    'empty columns',
    (g: any) => {
      g.datasets = { Events: defineDataset({ id: 'events', columns: {} }) };
      g.objects.Customer.datasets = {};
      g.policies.Customer.datasets = {};
    },
  ],
  [
    'null registry',
    (g: any) => {
      g.datasets = null;
    },
  ],
  [
    'null associations',
    (g: any) => {
      g.objects.Customer.datasets = null;
    },
  ],
  [
    'blank description',
    (g: any) => {
      const d = g.datasets.Events;

      g.datasets.Events = { ...d, description: '  ' };
      g.objects.Customer.datasets.events.dataset = g.datasets.Events;
    },
  ],
  [
    'folded columns',
    (g: any) => {
      const d = g.datasets.Events;

      g.datasets.Events = {
        ...d,
        columns: {
          ...d.columns,
          customerid: { ...d.columns.customerId, id: 'extra.column' },
        },
      };
      g.objects.Customer.datasets.events.dataset = g.datasets.Events;
    },
  ],
  [
    'duplicate stable id',
    (g: any) => {
      g.objects.Customer.datasets.events.id = 'events.customer';
    },
  ],
  [
    'object dataset API collision',
    (g: any) => {
      g.datasets.Customer = g.datasets.Events;
    },
  ],
] as const)('rejects %s even from erased JavaScript', (_label, change) => {
  expect(issues(altered(change)).length).toBeGreaterThan(0);
});

it.each([
  z.string().optional(),
  z.string().min(1),
  z.coerce.number(),
  z.int(),
  z.bigint(),
  z.number().transform((n) => n),
  z.string().refine(() => true),
  z.enum(['a']),
  z.iso.datetime({ offset: false, precision: 3 }),
  z.iso.datetime({ offset: true }),
  z.iso.datetime({ offset: true, precision: 4 }),
  z.array(z.string()),
  z.number().default(0),
  z.iso.date().refine(() => true),
  z.iso.date().min(10),
  z.iso.time(),
])(
  'rejects unsupported dataset schema %# without silently dropping constraints',
  (schema) => {
    const input = altered((g) => {
      const Events = defineDataset({
        id: 'new.events',
        columns: {
          value: {
            id: 'new.value',
            schema,
            access: g.access.groups.ordinary,
          },
        },
      });

      g.datasets = { Events };
      g.policies.Events = {};
      g.objects.Customer.datasets = {};
      g.policies.Customer.datasets = {};
    });

    expect(issues(input)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'schema.unsupported' }),
      ]),
    );
  },
);

it('rejects a separately supplied row schema and captures the column definitions', () => {
  const { access } = setup();

  expect(() =>
    defineDataset({ id: 'bad', columns: {}, schema: z.object({}) } as never),
  ).toThrow(CompileError);
  const columns = {
    key: {
      id: 'dataset.key',
      schema: z.string(),
      access: access.groups.ordinary,
    },
  };
  const dataset = defineDataset({ id: 'dataset', columns });

  columns.key.id = 'changed';
  expect(dataset.columns.key.id).toBe('dataset.key');
  expect(Object.isFrozen(dataset.columns.key)).toBe(true);
});

it('checks serialized manifests independently of the authoring compiler', () => {
  const model = compile(setup().graph);
  const manifest = structuredClone(model.manifest);

  manifest.objects[0]!.datasets![0]!.on[0]!.propertyDefinitionId =
    'another-object.property';
  expect(() => validateManifest(manifest)).toThrow('Correlation requires');
  const denied = structuredClone(model.manifest);

  denied.datasets![0]!.groups = {};
  expect(() => validateManifest(denied)).toThrow(
    'Missing dataset group policy',
  );
});

it('reports dataset and association paths using authored names', () => {
  const missing = issues(
    altered((g) => {
      g.policies.Events.groups = {};
    }),
  );

  expect(missing).toContainEqual(
    expect.objectContaining({
      path: {
        root: 'graph',
        segments: ['policies', 'Events', 'groups', 'identifying'],
      },
    }),
  );
  const duplicate = issues(
    altered((g) => {
      g.objects.Customer.datasets.events.on.push({
        column: 'customerId',
        property: 'tenantId',
      });
    }),
  );

  expect(duplicate).toContainEqual(
    expect.objectContaining({
      path: {
        root: 'graph',
        segments: ['objects', 'Customer', 'datasets', 'events', 'on'],
      },
    }),
  );
});
