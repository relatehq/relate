import { z } from 'zod';
import type { Manifest, ScalarSchema } from '../model.js';
import type { ModelIssueCode } from '../diagnostics.js';

const text = z.string().min(1);
const prose = z.string().regex(/\S/, 'Description must not be blank');
const gate = z.strictObject({ role: text });

export const datasetTypeSchema = z.union([
  z.strictObject({
    type: z.enum(['boolean', 'string', 'int32', 'int64', 'float64']),
    nullable: z.boolean(),
  }),
  z.strictObject({
    type: z.literal('timestamp'),
    precision: z.union([z.literal(3), z.literal(6)]),
    nullable: z.boolean(),
  }),
]);

export const datasetSchema = z.strictObject({
  id: text,
  apiName: text,
  description: prose.optional(),
  columns: z
    .array(
      z.strictObject({
        id: text,
        name: text,
        description: prose.optional(),
        access: text,
        schema: datasetTypeSchema,
      }),
    )
    .min(1),
  groups: z.record(text, gate),
});

export const associationSchema = z.strictObject({
  id: text,
  name: text,
  datasetDefinitionId: text,
  on: z
    .array(
      z.strictObject({ columnDefinitionId: text, propertyDefinitionId: text }),
    )
    .min(1),
  gate,
});

export type CompiledDataset = z.infer<typeof datasetSchema>;
export type CompiledAssociation = z.infer<typeof associationSchema>;

type Path = readonly (string | number)[];

export interface DatasetIssueReporter {
  report(
    code: ModelIssueCode,
    message: string,
    path: Path,
    definitionId?: string,
  ): void;
}

const unsafe = new Set(['__proto__', 'prototype', 'constructor']);

/** Logical correlation type for existing ordinary portable scalar properties. */
function propertyType(
  schema: ScalarSchema,
): z.infer<typeof datasetTypeSchema> | undefined {
  if (schema.format === 'local-datetime') return undefined;

  if (schema.format === 'timestamp')
    return {
      type: 'timestamp',
      precision: 3,
      nullable: schema.nullable || schema.optional,
    };

  return {
    type: schema.type === 'number' ? 'float64' : schema.type,
    nullable: schema.nullable || schema.optional,
  };
}

export function validateDatasets(
  manifest: Manifest,
  issues: DatasetIssueReporter,
  register: (id: string, path: Path) => boolean,
): void {
  const datasets = manifest.datasets ?? [];
  const byId = new Map(datasets.map((dataset) => [dataset.id, dataset]));
  const apiNames = new Set(manifest.objects.map((object) => object.apiName));

  function names(entries: readonly { name: string; id: string }[], path: Path) {
    const folded = new Set<string>();

    entries.forEach((entry, index) => {
      if (!entry.name.trim() || unsafe.has(entry.name))
        issues.report(
          'dataset.invalid-name',
          'Invalid analytical name',
          [...path, index, 'name'],
          entry.id,
        );

      if (folded.has(entry.name.toLowerCase()))
        issues.report(
          'analytics.folded-name-collision',
          `Names collide after SQL folding: '${entry.name}'`,
          [...path, index, 'name'],
          entry.id,
        );

      folded.add(entry.name.toLowerCase());
    });
  }

  datasets.forEach((dataset, index) => {
    const at = (...rest: (string | number)[]) => ['datasets', index, ...rest];

    register(dataset.id, at('id'));

    if (
      !dataset.apiName.trim() ||
      unsafe.has(dataset.apiName) ||
      apiNames.has(dataset.apiName)
    )
      issues.report(
        'dataset.invalid-name',
        'Dataset API names must be unique across objects and datasets',
        at('apiName'),
        dataset.id,
      );

    apiNames.add(dataset.apiName);
    names(dataset.columns, at('columns'));
    dataset.columns.forEach((column, columnIndex) => {
      register(column.id, at('columns', columnIndex, 'id'));

      if (!manifest.fieldGroups.includes(column.access))
        issues.report(
          'property.unknown-field-group',
          `Unknown dataset field group '${column.access}'`,
          at('columns', columnIndex, 'access'),
          column.id,
        );

      if (
        column.access !== 'ordinary' &&
        !Object.hasOwn(dataset.groups, column.access)
      )
        issues.report(
          'policy.missing',
          `Missing dataset group policy '${column.access}'`,
          at('groups', column.access),
          dataset.id,
        );
    });

    for (const [group, rule] of Object.entries(dataset.groups)) {
      if (group === 'ordinary' || !manifest.fieldGroups.includes(group))
        issues.report(
          'policy.invalid-group',
          `Invalid dataset policy group '${group}'`,
          at('groups', group),
          dataset.id,
        );

      if (!manifest.roles.includes(rule.role))
        issues.report(
          'policy.unknown-role',
          `Unknown dataset role '${rule.role}'`,
          at('groups', group),
          dataset.id,
        );
    }
  });
  manifest.objects.forEach((object, index) => {
    names(object.properties, ['objects', index, 'properties']);
    const associations = object.datasets ?? [];

    names(associations, ['objects', index, 'datasets']);
    associations.forEach((association, associationIndex) => {
      const at = (...rest: (string | number)[]) => [
        'objects',
        index,
        'datasets',
        associationIndex,
        ...rest,
      ];

      register(association.id, at('id'));

      if (!manifest.roles.includes(association.gate.role))
        issues.report(
          'policy.unknown-role',
          'Unknown association policy role',
          at('gate'),
          association.id,
        );

      const dataset = byId.get(association.datasetDefinitionId);

      if (!dataset) {
        issues.report(
          'dataset.unknown',
          'Association requires a registered dataset',
          at('datasetDefinitionId'),
          association.id,
        );

        return;
      }

      const used = new Set<string>();

      association.on.forEach((pair, pairIndex) => {
        const column = dataset.columns.find(
          (column) => column.id === pair.columnDefinitionId,
        );
        const property = object.properties.find(
          (property) => property.id === pair.propertyDefinitionId,
        );
        const type =
          property &&
          !['reference', 'native-reference'].includes(property.origin.kind)
            ? propertyType(property.schema)
            : undefined;

        if (
          !column ||
          !type ||
          used.has(pair.columnDefinitionId) ||
          type.type === 'float64' ||
          type.type !== column.schema.type
        )
          issues.report(
            'association.invalid-correlation',
            'Correlation requires distinct dataset columns and ordinary properties of the same non-floating logical type',
            at('on', pairIndex),
            association.id,
          );

        used.add(pair.columnDefinitionId);
      });
    });
  });
}
