import { z } from 'zod';
import type { AccessDefinition, FieldGroup, Policy } from './authorization.js';

declare const objectIdBrand: unique symbol;

/** A canonical record ID, scoped to its stable object definition ID. */
export type ObjectId<DefinitionId extends string> = string & {
  readonly [objectIdBrand]: DefinitionId;
};

/**
 * A string on the wire and in memory; no wrapper, lookup, or access grant.
 * Typed calls require an already branded ID. Use `.parse(unknown)` at external
 * boundaries to validate a nonblank string and declare its expected object type.
 * Parsing cannot establish existence, actual object type, or authorization.
 */
export function referenceInput<
  O extends Pick<ObjectDefinition, 'id' | 'properties'>,
>(object: O): z.ZodType<ObjectId<O['id']>, ObjectId<O['id']>> {
  // The object supplies compile-time identity; the runtime still checks membership.
  void object;

  return z
    .string()
    .regex(/\S/, 'Object ID must not be blank') as unknown as z.ZodType<
    ObjectId<O['id']>,
    ObjectId<O['id']>
  >;
}

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
    | {
        readonly kind: 'reference';
        readonly sourceDefinitionId: string;
        readonly field: string;
        readonly targetObjectDefinitionId: string;
      }
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

/** A source key resolved through the target's existing membership identity. */
export interface ReferenceProperty<
  Target extends string = string,
> extends Property<z.ZodString> {
  readonly references: Target;
  readonly origin: {
    readonly kind: 'reference';
    readonly sourceDefinitionId: string;
    readonly field: string;
    readonly targetObjectDefinitionId: Target;
  };
}

export function reference<O extends ObjectDefinition, const Id extends string>(
  target: O,
  options: { id: Id; access: FieldGroup; from: FieldReference<z.ZodString> },
): ReferenceProperty<O['id']> & { readonly id: Id } {
  return Object.freeze({
    id: options.id,
    access: options.access,
    schema: z.string(),
    references: target.id,
    origin: Object.freeze({
      kind: 'reference' as const,
      sourceDefinitionId: options.from.sourceDefinitionId,
      field: options.from.field,
      targetObjectDefinitionId: target.id,
    }),
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

export function defineObject<
  const Id extends string,
  const P extends Record<string, Property>,
>(
  definition: Omit<ObjectDefinition, 'id' | 'properties'> & {
    id: Id;
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

export interface Traversal {
  readonly name: string;
  readonly cardinality: 'one' | 'many';
}

export interface RelationshipDefinition<
  From extends ObjectDefinition = ObjectDefinition,
  To extends ObjectDefinition = ObjectDefinition,
  Forward extends Traversal = Traversal,
  Reverse extends Traversal = Traversal,
> {
  readonly id: string;
  readonly from: From;
  readonly to: To;
  readonly forward: Forward;
  readonly reverse: Reverse;
  readonly via: ReferenceProperty<From['id']>;
}

export function defineRelationship<
  From extends ObjectDefinition,
  To extends ObjectDefinition,
  const Forward extends { readonly name: string; readonly cardinality: 'many' },
  const Reverse extends { readonly name: string; readonly cardinality: 'one' },
>(definition: {
  id: string;
  from: From;
  to: To;
  forward: Forward;
  reverse: Reverse;
  via: Extract<
    NoInfer<To>['properties'][keyof NoInfer<To>['properties']],
    ReferenceProperty<NoInfer<From>['id']>
  >;
}): RelationshipDefinition<From, To, Forward, Reverse> {
  return Object.freeze({
    ...definition,
    forward: Object.freeze({ ...definition.forward }),
    reverse: Object.freeze({ ...definition.reverse }),
  });
}

export type RelationshipRegistry = Readonly<
  Record<string, RelationshipDefinition>
>;

export type ObjectRegistry = Readonly<Record<string, ObjectDefinition>>;

export type PropertyNames<O extends ObjectDefinition> = keyof O['properties'] &
  string;

/** Identity is contextual: own IDs use the owner, references use their target. */
export type PropertyValue<
  O extends Pick<ObjectDefinition, 'id' | 'properties'>,
  N extends keyof O['properties'],
> = O['properties'][N] extends {
  readonly references: infer Target extends string;
}
  ? ObjectId<Target>
  : O['properties'][N] extends ObjectIdProperty
    ? ObjectId<O['id']>
    : z.output<O['properties'][N]['schema']>;

/** Selected fields remain optional: selection never grants access or guarantees availability. */
export type ObjectData<
  O extends ObjectDefinition,
  K extends PropertyNames<O> = PropertyNames<O>,
> = {
  readonly [N in K]?: PropertyValue<O, N>;
};

export interface GraphDefinition {
  readonly id: string;
  readonly objects: readonly ObjectDefinition[] | ObjectRegistry;
  readonly relationships?: RelationshipRegistry;
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
  PolicyWhere,
  RoleGate,
} from './authorization.js';
