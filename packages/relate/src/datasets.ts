import { z } from 'zod';
import type { FieldGroup } from './authorization.js';
import { CompileError } from './diagnostics.js';
import { recordProvenance } from './provenance.js';

export interface DatasetColumn<S extends z.ZodType = z.ZodType> {
  readonly id: string;
  readonly schema: S;
  readonly access: FieldGroup;
  readonly description?: string;
}

export type DatasetColumns = Readonly<Record<string, DatasetColumn>>;

export interface DatasetDefinition<C extends DatasetColumns = DatasetColumns> {
  readonly kind: 'dataset';
  readonly id: string;
  readonly description?: string;
  readonly columns: C;
  /** Derived from the column schemas; rows have no key and may repeat. */
  readonly schema: z.ZodObject<{ [K in keyof C]: C[K]['schema'] }>;
}

/** Declare an unbound row contract; the columns are the only schema input. */
export function defineDataset<const C extends DatasetColumns>(definition: {
  readonly id: string;
  readonly description?: string;
  readonly columns: C;
  readonly schema?: never;
}): DatasetDefinition<C> {
  if (
    !definition ||
    typeof definition !== 'object' ||
    Object.keys(definition).some(
      (key) => !['id', 'description', 'columns'].includes(key),
    ) ||
    !definition.columns ||
    typeof definition.columns !== 'object' ||
    Array.isArray(definition.columns)
  )
    throw new CompileError([
      {
        code: 'dataset.invalid-shape',
        message:
          'A dataset requires column declarations and derives its row schema from them',
        path: { root: 'definition', segments: [] },
      },
    ]);

  const columns = Object.freeze(
    Object.fromEntries(
      Object.entries(definition.columns).map(([name, column]) => [
        name,
        Object.freeze({ ...column }),
      ]),
    ),
  ) as C;
  const shape = Object.fromEntries(
    Object.entries(columns).map(([name, column]) => [name, column.schema]),
  ) as {
    [K in keyof C]: C[K]['schema'];
  };

  return recordProvenance(
    Object.freeze({
      kind: 'dataset',
      id: definition.id,
      ...(definition.description === undefined
        ? {}
        : { description: definition.description }),
      columns,
      schema: z.object(shape),
    }),
  );
}

export type DatasetRow<D extends DatasetDefinition> = z.output<D['schema']>;
export type DatasetRegistry = Readonly<Record<string, DatasetDefinition>>;

export interface DatasetAssociation<
  D extends DatasetDefinition = DatasetDefinition,
> {
  readonly id: string;
  readonly dataset: D;
  readonly on: readonly [
    { readonly column: string; readonly property: string },
    ...{ readonly column: string; readonly property: string }[],
  ];
}

export type DatasetAssociations = Readonly<Record<string, DatasetAssociation>>;

/** Check names against their own dataset and containing object, without widening inference. */
export type CheckedAssociations<P, D extends DatasetAssociations> = {
  readonly [K in keyof D]: {
    readonly on: readonly {
      readonly column: Extract<keyof D[K]['dataset']['columns'], string>;
      readonly property: Extract<keyof P, string>;
    }[];
  };
};
