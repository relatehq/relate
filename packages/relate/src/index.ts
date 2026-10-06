import { z } from 'zod';
import type { AccessDefinition, FieldGroup, Policy } from './authorization.js';

export interface FieldReference<S extends z.ZodType = z.ZodType> {
  readonly sourceDefinitionId: string;
  readonly field: string;
  readonly schema: S;
}

export interface SourceDefinition {
  readonly id: string;
  readonly idField: string;
  readonly schema: z.ZodObject;
}

export function defineSource<S extends Record<string, z.ZodType>>(definition: {
  id: string;
  idField: Extract<keyof S, string>;
  schema: z.ZodObject<S>;
}) {
  const fields = Object.fromEntries(
    Object.entries(definition.schema.shape).map(([field, schema]) => [
      field,
      Object.freeze({
        sourceDefinitionId: definition.id,
        field,
        schema,
      }),
    ]),
  ) as { readonly [K in keyof S]: FieldReference<S[K]> };

  return Object.freeze({ ...definition, fields: Object.freeze(fields) });
}

export interface Property<S extends z.ZodType = z.ZodType> {
  readonly id: string;
  readonly access: FieldGroup;
  readonly schema: S;
  readonly origin:
    | { readonly kind: 'native' }
    | { readonly kind: 'object-id' }
    | {
        readonly kind: 'source';
        readonly sourceDefinitionId: string;
        readonly field: string;
      };
}

export interface ObjectIdProperty extends Property<z.ZodString> {
  readonly origin: { readonly kind: 'object-id' };
}

export function objectId<const Id extends string>(options: {
  id: Id;
  access: FieldGroup<'ordinary'>;
}): ObjectIdProperty & { readonly id: Id } {
  return Object.freeze({
    ...options,
    schema: z.string(),
    origin: Object.freeze({ kind: 'object-id' as const }),
  });
}

export function native<S extends z.ZodType, const Id extends string>(
  schema: S,
  options: { id: Id; access: FieldGroup },
): Property<S> & { readonly id: Id } {
  return Object.freeze({
    ...options,
    schema,
    origin: { kind: 'native' as const },
  });
}

export function from<S extends z.ZodType, const Id extends string>(
  field: FieldReference<S>,
  options: { id: Id; access: FieldGroup },
): Property<S> & { readonly id: Id } {
  return Object.freeze({
    ...options,
    schema: field.schema,
    origin: {
      kind: 'source' as const,
      sourceDefinitionId: field.sourceDefinitionId,
      field: field.field,
    },
  });
}

export function source(resource: SourceDefinition) {
  return Object.freeze({ resource });
}

export interface ObjectDefinition {
  readonly id: string;
  readonly name: string;
  readonly membership: ReturnType<typeof source>;
  readonly properties: Readonly<Record<string, Property>>;
}

export function defineObject<const P extends Record<string, Property>>(
  definition: Omit<ObjectDefinition, 'properties'> & {
    properties: P;
  },
) {
  if (
    Object.values(definition.properties).filter(
      (p) => p.origin.kind === 'object-id',
    ).length !== 1
  )
    throw new Error('Each object must have exactly one objectId() property');

  return Object.freeze({
    ...definition,
    properties: Object.freeze({ ...definition.properties }),
  });
}

export interface GraphDefinition {
  readonly id: string;
  readonly objects: readonly ObjectDefinition[];
  readonly access: AccessDefinition;
  readonly policies: readonly Policy[];
}

export function defineGraph<const G extends GraphDefinition>(graph: G): G {
  return graph;
}

export { defineAccess, equals } from './authorization.js';

export type {
  AccessDefinition,
  Claim,
  Equality,
  FieldGroup,
  Policy,
  RoleGate,
} from './authorization.js';
