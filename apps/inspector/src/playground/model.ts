/**
 * What the playground reads from a principal's discovery. Every editor
 * feature (completion, checks, the schema tree, result headers) asks this
 * module, so a change in the discovery shape is absorbed here.
 *
 * Datasets and computed properties come from actor-bound runtime discovery.
 * Ordinary objects omit analytical metadata:
 *
 *   object.datasets.events = {
 *     description: 'One row per recorded customer event.',
 *     columns: { occurredAt: { type: 'timestamp', precision: 3 }, … },
 *     correlation: 'customerId = self.externalId',
 *   }
 */
import type {
  PlaygroundDiscovery,
  PlaygroundObject,
  PlaygroundProperty,
} from '../protocol.js';

export type ReadOperation = 'get' | 'query';

export interface Column {
  readonly name: string;
  /** Logical type, such as `string`, `int64` or `timestamp`. */
  readonly type: string;
  readonly nullable: boolean;
  /** False when the principal may use the association but not this column. */
  readonly readable: boolean;
  readonly description?: string;
}

export interface Dataset {
  /** The association name used in SQL: `FROM self.<name>`. */
  readonly name: string;
  readonly description?: string;
  /** How rows match the object, such as `customerId = self.externalId`. */
  readonly correlation?: string;
  readonly columns: readonly Column[];
}

export const objectNames = (discovery: PlaygroundDiscovery): string[] =>
  Object.keys(discovery.objects).sort((a, b) => a.localeCompare(b));

export const objectOf = (
  discovery: PlaygroundDiscovery | null,
  name: string | null,
): PlaygroundObject | undefined =>
  discovery && name !== null && Object.hasOwn(discovery.objects, name)
    ? discovery.objects[name]
    : undefined;

/** Option names `operation` accepts, or null when discovery does not list them. */
export function acceptedOptions(
  discovery: PlaygroundDiscovery,
  operation: ReadOperation,
): ReadonlyMap<string, string> | null {
  const options = discovery.overview.sdk?.options;

  if (!options) return null;

  return new Map(
    Object.entries(options)
      .filter(([, option]) => option.operations.includes(operation))
      .map(([name, option]) => [name, option.description]),
  );
}

/** A declared computed property: the runtime evaluates it, nothing stores it. */
export const isComputed = (property: PlaygroundProperty): boolean =>
  property.kind === 'computed' || property['computed'] === true;

/**
 * Whether `where` accepts the property: discovery lists its operators. Today
 * every readable property is filterable; a declared computed property may be
 * listed without operators and is filtered by its result type.
 */
export const isFilterable = (property: PlaygroundProperty): boolean =>
  property.filterOperators !== undefined
    ? property.filterOperators.length > 0
    : isComputed(property);

/** A short type label for a property: `string`, `timestamp`, `number?`. */
export function propertyType(property: PlaygroundProperty): string {
  const logical = property['type'];
  const schema = property.schema;
  const base =
    typeof logical === 'string'
      ? logical
      : property.kind === 'reference'
        ? 'reference'
        : (schema.format ?? schema.type);

  return schema.nullable || schema.optional ? `${base}?` : base;
}

export function columnType(column: Column): string {
  return column.nullable ? `${column.type}?` : column.type;
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** The object's actor-visible datasets; ordinary objects have none. */
export function datasetsOf(object: PlaygroundObject | undefined): Dataset[] {
  const datasets = record(object?.['datasets']);

  if (!datasets) return [];

  return Object.entries(datasets).flatMap(([name, raw]) => {
    const dataset = record(raw);
    const columns = record(dataset?.['columns']);

    if (!dataset || !columns) return [];

    return [
      {
        name,
        ...(typeof dataset['description'] === 'string'
          ? { description: dataset['description'] }
          : {}),
        ...(typeof dataset['correlation'] === 'string'
          ? { correlation: dataset['correlation'] }
          : {}),
        columns: Object.entries(columns).flatMap(([column, rawColumn]) => {
          const value = record(rawColumn);

          if (!value || typeof value['type'] !== 'string') return [];

          return [
            {
              name: column,
              type: value['type'],
              nullable: value['nullable'] === true,
              readable: value['readable'] !== false,
              ...(typeof value['description'] === 'string'
                ? { description: value['description'] }
                : {}),
            },
          ];
        }),
      },
    ];
  });
}

/** Matching follows the SQL identifier rule: unquoted names fold case. */
export const sameName = (a: string, b: string) =>
  a.toLowerCase() === b.toLowerCase();
