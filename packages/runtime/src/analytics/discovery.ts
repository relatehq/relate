import type {
  ComputeDescription,
  ComputedPropertyDescription,
  DatasetDescription,
} from '@relate/protocol';
import type { Manifest } from 'relate/model';
import type { SqlParser, AnalyticalLimits } from 'relate/analytics';
import {
  actorAssociations,
  analyticalDeclarations,
} from '../authorization/index.js';
import type { Principal } from '../authorization/index.js';
import {
  authorizeDeclaration,
  prepareExpression,
  computedFilterOperators,
} from './index.js';

const quote = (name: string) => `"${name.replaceAll('"', '""')}"`;

/** Metadata uses the same actor view and declaration authorization as execution. */
export function analyticalDiscovery(
  manifest: Manifest,
  principal: Principal,
  object: Manifest['objects'][number],
  parser?: SqlParser,
  limits: AnalyticalLimits = {},
) {
  const scope = actorAssociations(manifest, principal, object);
  const datasets: Record<string, DatasetDescription> = Object.fromEntries(
    scope.associations.map((association) => {
      const correlation = association.on.map((pair) => ({
        column: association.columns.find(
          (column) => column.id === pair.columnDefinitionId,
        )!,
        property: scope.properties.find(
          (property) => property.id === pair.propertyDefinitionId,
        )!,
      }));

      return [
        association.name,
        {
          definitionId: association.id,
          datasetDefinitionId: association.datasetDefinitionId,
          ...(association.description === undefined
            ? {}
            : { description: association.description }),
          columns: Object.fromEntries(
            association.columns.map((column) => [
              column.name,
              {
                definitionId: column.id,
                ...column.schema,
                readable: column.readable,
                ...(column.description === undefined
                  ? {}
                  : { description: column.description }),
              },
            ]),
          ),
          ...(correlation.every(({ property }) => property.readable)
            ? {
                correlation: correlation
                  .map(
                    ({ column, property }) =>
                      `${quote(column.name)} = self.${quote(property.name)}`,
                  )
                  .join(' AND '),
              }
            : {}),
        },
      ];
    }),
  );
  const declarations = analyticalDeclarations(manifest, object);
  const properties: ComputedPropertyDescription[] = (
    object.calculations ?? []
  ).flatMap((property) => {
    if (!scope.properties.find((entry) => entry.id === property.id)?.readable)
      return [];

    if (!parser)
      throw new Error(
        'Analytical discovery requires an initialized SQL parser',
      );

    const expression = authorizeDeclaration(
      prepareExpression({
        ...limits,
        parser,
        scope: declarations,
        expression: { sql: property.sql },
        declared: true,
      }),
      scope,
    );

    return [
      {
        definitionId: property.id,
        name: property.name,
        ...(property.description === undefined
          ? {}
          : { description: property.description }),
        kind: 'computed',
        schema: { ...expression.aggregate.result },
        readable: !expression.forbidden && !expression.correlationForbidden,
        filter:
          'Computed comparisons use the logical result type; null never matches. Ordering places nulls last and breaks ties by object ID.',
        filterOperators:
          expression.forbidden || expression.correlationForbidden
            ? []
            : computedFilterOperators(expression.aggregate.result),
      },
    ];
  });
  const first = scope.associations[0];
  const compute: ComputeDescription = {
    syntax:
      'SELECT <aggregate> FROM self.<dataset> [AS alias] [WHERE predicate]',
    aggregates: ['COUNT', 'COUNT DISTINCT', 'SUM', 'AVG', 'MIN', 'MAX'],
    encoding:
      'int64 results are canonical decimal JSON strings; timestamps are UTC strings with declared precision.',
    identifiers:
      'Unquoted names match declared names case-insensitively; quoted names match exactly.',
    filters:
      'Object queries accept computed aliases and declared calculations in where and orderBy. These fields are required across the full authorized ordinary-filter scope; null never matches. Traversal and action transactions do not accept calculations.',
    freshness:
      'Dataset inputs are read live, but their source freshness is unverified. Ordinary dependencies follow read freshness controls.',
    ...(first
      ? { example: `SELECT COUNT(*) FROM self.${quote(first.name)}` }
      : {}),
  };

  return {
    properties,
    ...(scope.associations.length ? { datasets } : {}),
    ...(scope.associations.length || properties.length ? { compute } : {}),
  };
}
