import type { GraphDefinition } from '../index.js';
import type { DatasetDefinition } from '../datasets.js';
import type {
  CompiledDataset,
  CompiledAssociation,
  DatasetIssueReporter,
} from '../model/datasets.js';
import { datasetType } from './dataset-types.js';

type Path = (string | number)[];

const record = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);
const described = (value: string | undefined) =>
  value === undefined ? {} : { description: value };
const sortId = (a: { id: string }, b: { id: string }) =>
  a.id < b.id ? -1 : a.id > b.id ? 1 : 0;

export function compileDatasets(
  graph: GraphDefinition,
  issues: DatasetIssueReporter,
) {
  const datasets: CompiledDataset[] = [];
  const associations: Record<string, CompiledAssociation[]> = {};
  const registry = graph.datasets === undefined ? {} : graph.datasets;

  if (!record(registry)) {
    issues.report(
      'dataset.invalid-shape',
      'Datasets must be a keyed registry',
      ['datasets'],
    );

    return { datasets, associations };
  }

  const registered = new Map<DatasetDefinition, string>();
  const gate = (
    input: unknown,
    at: Path,
    id: string,
  ): { role: string } | undefined => {
    if (
      !record(input) ||
      input.kind !== 'role' ||
      typeof input.role !== 'string' ||
      Object.keys(input).some((key) => !['kind', 'role'].includes(key))
    ) {
      issues.report(
        'policy.unsupported-gate',
        'Expected a declared role gate',
        at,
        id,
      );

      return undefined;
    }

    if (!graph.access.roles.includes(input.role))
      issues.report(
        'policy.unknown-role',
        `Unknown role '${input.role}'`,
        at,
        id,
      );

    return { role: input.role };
  };

  for (const [name, dataset] of Object.entries(registry)) {
    const at = (...rest: (string | number)[]) => ['datasets', name, ...rest];

    if (!dataset || dataset.kind !== 'dataset' || !record(dataset.columns)) {
      issues.report(
        'dataset.invalid-shape',
        'Expected a dataset definition with column-owned schemas',
        at(),
      );
      continue;
    }

    registered.set(dataset, name);
    const columns: CompiledDataset['columns'] = [];

    for (const [columnName, column] of Object.entries(dataset.columns)) {
      const here = at('columns', columnName);

      if (
        !column ||
        typeof column !== 'object' ||
        column.access?.kind !== 'field-group' ||
        Object.keys(column).some(
          (key) => !['id', 'schema', 'access', 'description'].includes(key),
        )
      ) {
        issues.report(
          'dataset.invalid-shape',
          'Dataset columns require a schema, stable ID and field group',
          here,
          dataset.id,
        );
        continue;
      }

      try {
        columns.push({
          id: column.id,
          name: columnName,
          ...described(column.description),
          access: column.access.name,
          schema: datasetType(column.schema),
        });
      } catch (error) {
        issues.report(
          'schema.unsupported',
          error instanceof Error ? error.message : 'Invalid dataset schema',
          [...here, 'schema'],
          column.id,
        );
      }
    }

    const input = Object.hasOwn(graph.policies, name)
      ? graph.policies[name]
      : undefined;
    const groups: CompiledDataset['groups'] = {};

    if (input === undefined)
      issues.report(
        'policy.missing',
        `Missing dataset policy: ${name}`,
        ['policies', name],
        dataset.id,
      );
    else if (
      !record(input) ||
      Object.keys(input).some((key) => key !== 'groups') ||
      (input.groups !== undefined && !record(input.groups))
    )
      issues.report(
        'policy.invalid-rule',
        'Dataset policies support column groups only',
        ['policies', name],
        dataset.id,
      );
    else
      for (const [group, rule] of Object.entries(input.groups ?? {})) {
        const compiled = gate(
          rule,
          ['policies', name, 'groups', group],
          dataset.id,
        );

        if (compiled) groups[group] = compiled;
      }

    datasets.push({
      id: dataset.id,
      apiName: name,
      ...described(dataset.description),
      columns: columns.sort(sortId),
      groups,
    });
  }

  for (const [name, object] of Object.entries(graph.objects)) {
    if (!object || !record(object.properties)) continue;

    const input = object.datasets === undefined ? {} : object.datasets;

    if (!record(input)) {
      issues.report(
        'association.invalid-shape',
        'Object datasets must be a keyed registry',
        ['objects', name, 'datasets'],
        object.id,
      );
      continue;
    }

    const policy = graph.policies[name];
    const rules = policy && 'datasets' in policy ? policy.datasets : undefined;

    if (rules !== undefined && !record(rules))
      issues.report(
        'policy.invalid-rule',
        'Association policies must be a keyed registry',
        ['policies', name, 'datasets'],
        object.id,
      );

    for (const ruleName of Object.keys(rules ?? {}))
      if (!Object.hasOwn(input, ruleName))
        issues.report(
          'policy.unknown-dependency',
          `Unknown dataset association '${ruleName}'`,
          ['policies', name, 'datasets', ruleName],
          object.id,
        );

    const compiled: CompiledAssociation[] = [];

    for (const [associationName, association] of Object.entries(input)) {
      const at = (...rest: (string | number)[]) => [
        'objects',
        name,
        'datasets',
        associationName,
        ...rest,
      ];

      if (!association || !registered.has(association.dataset)) {
        issues.report(
          'dataset.unknown',
          'Association dataset must be the registered definition',
          at('dataset'),
          association?.id,
        );
        continue;
      }

      if (
        Object.keys(association).some(
          (key) => !['id', 'dataset', 'on'].includes(key),
        ) ||
        !Array.isArray(association.on) ||
        !association.on.length
      ) {
        issues.report(
          'association.invalid-shape',
          'Association on requires a non-empty array of { column, property } pairs',
          at('on'),
          association.id,
        );
        continue;
      }

      const on: CompiledAssociation['on'] = [];

      association.on.forEach((pair, index) => {
        if (
          !record(pair) ||
          Object.keys(pair).length !== 2 ||
          typeof pair.column !== 'string' ||
          typeof pair.property !== 'string' ||
          !Object.hasOwn(association.dataset.columns, pair.column) ||
          !Object.hasOwn(object.properties, pair.property)
        ) {
          issues.report(
            'association.invalid-correlation',
            'Correlation must name a declared dataset column and a property of this object',
            at('on', index),
            association.id,
          );

          return;
        }

        on.push({
          columnDefinitionId: association.dataset.columns[pair.column]!.id,
          propertyDefinitionId: object.properties[pair.property]!.id,
        });
      });
      const rule =
        rules && Object.hasOwn(rules, associationName)
          ? rules[associationName]
          : undefined;

      if (!rule) {
        issues.report(
          'policy.missing',
          `Missing association policy: ${name}.datasets.${associationName}`,
          ['policies', name, 'datasets', associationName],
          association.id,
        );
        continue;
      }

      if (!record(rule) || Object.keys(rule).some((key) => key !== 'gate')) {
        issues.report(
          'policy.invalid-rule',
          'Association policies support a role gate only',
          ['policies', name, 'datasets', associationName],
          association.id,
        );
        continue;
      }

      const compiledGate = gate(
        rule.gate,
        ['policies', name, 'datasets', associationName, 'gate'],
        association.id,
      );

      if (compiledGate)
        compiled.push({
          id: association.id,
          name: associationName,
          datasetDefinitionId: association.dataset.id,
          on: on.sort((a, b) =>
            a.columnDefinitionId < b.columnDefinitionId
              ? -1
              : a.columnDefinitionId > b.columnDefinitionId
                ? 1
                : 0,
          ),
          gate: compiledGate,
        });
    }

    associations[object.id] = compiled.sort(sortId);
  }

  return { datasets: datasets.sort(sortId), associations };
}
