import { z } from 'zod';
import { referenceSchemas } from './schema.js';
import { CompileError } from './diagnostics.js';
import { recordProvenance } from './provenance.js';
import type { ActionDefinition } from './actions.js';
import type {
  AccessDefinition,
  ExactPolicyInput,
  FieldGroup,
  Policies,
  Policy,
} from './authorization.js';

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
>(
  object: O,
  options?: { readonly description?: string },
): z.ZodType<ObjectId<O['id']>, ObjectId<O['id']>> {
  // The object supplies compile-time identity; the runtime still checks membership.
  void object;

  const base = z.string().regex(/\S/, 'Object ID must not be blank');
  const schema =
    options?.description !== undefined
      ? base.describe(options.description)
      : base;

  // Keyed by definition so `.describe()` and `.meta()` clones stay references.
  referenceSchemas.set(schema.def, object.id);

  return schema as unknown as z.ZodType<ObjectId<O['id']>, ObjectId<O['id']>>;
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

  return recordProvenance(
    Object.freeze({ ...definition, fields: Object.freeze(fields) }),
  );
}

export interface Property<S extends z.ZodType = z.ZodType> {
  readonly id: string;
  /** Explanatory text for people, documentation, and agents. */
  readonly description?: string | undefined;
  /** Defaults to the ordinary field group. */
  readonly access?: FieldGroup | undefined;
  readonly schema: S;
  readonly origin:
    | {
        readonly kind: 'reference';
        readonly sourceDefinitionId: string;
        readonly field: string;
        readonly targetObjectDefinitionId: string;
      }
    | {
        readonly kind: 'native-reference';
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
  description?: string;
  access?: FieldGroup<'ordinary'>;
}): ObjectIdProperty & { readonly id: Id } {
  return Object.freeze({
    ...options,
    schema: z.string(),
    origin: Object.freeze({ kind: 'object-id' as const }),
  });
}

export function native<S extends z.ZodType, const Id extends string>(
  schema: S,
  options: { id: Id; description?: string; access?: FieldGroup },
): Property<S> & {
  readonly id: Id;
  readonly origin: { readonly kind: 'native' };
} {
  return Object.freeze({
    ...options,
    schema,
    origin: { kind: 'native' as const },
  });
}

export function from<S extends z.ZodType, const Id extends string>(
  field: FieldReference<S>,
  options: { id: Id; description?: string; access?: FieldGroup },
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
  TargetObject extends ObjectDefinition = ObjectDefinition,
> extends Property<z.ZodString> {
  readonly references: Target;
  readonly target: TargetObject;
  readonly origin:
    | {
        readonly kind: 'native-reference';
        readonly targetObjectDefinitionId: Target;
      }
    | {
        readonly kind: 'reference';
        readonly sourceDefinitionId: string;
        readonly field: string;
        readonly targetObjectDefinitionId: Target;
      };
}

export function reference<O extends ObjectDefinition, const Id extends string>(
  target: O,
  options: {
    id: Id;
    description?: string;
    access?: FieldGroup;
    from: FieldReference<z.ZodString>;
  },
): ReferenceProperty<O['id'], O> & {
  readonly id: Id;
  readonly origin: Extract<
    ReferenceProperty<O['id'], O>['origin'],
    { kind: 'reference' }
  >;
};

export function reference<O extends ObjectDefinition, const Id extends string>(
  target: O,
  options: { id: Id; description?: string; access?: FieldGroup },
): ReferenceProperty<O['id'], O> & {
  readonly id: Id;
  readonly origin: {
    readonly kind: 'native-reference';
    readonly targetObjectDefinitionId: O['id'];
  };
};

export function reference<O extends ObjectDefinition, const Id extends string>(
  target: O,
  options: {
    id: Id;
    description?: string;
    access?: FieldGroup;
    from?: FieldReference<z.ZodString>;
  },
): ReferenceProperty<O['id'], O> & { readonly id: Id } {
  return Object.freeze({
    id: options.id,
    ...(options.description !== undefined
      ? { description: options.description }
      : {}),
    access: options.access,
    schema: z.string(),
    references: target.id,
    target,
    origin: options.from
      ? Object.freeze({
          kind: 'reference' as const,
          sourceDefinitionId: options.from.sourceDefinitionId,
          field: options.from.field,
          targetObjectDefinitionId: target.id,
        })
      : Object.freeze({
          kind: 'native-reference' as const,
          targetObjectDefinitionId: target.id,
        }),
  });
}

export interface NativeMembership {
  readonly kind: 'native';
}

export function nativeMembership(): NativeMembership {
  return Object.freeze({ kind: 'native' });
}

export type Membership = ReturnType<typeof source> | NativeMembership;

export function source(resource: SourceDefinition) {
  return Object.freeze({ resource });
}

export interface ObjectDefinition {
  readonly id: string;
  /** Singular UI label; defaults to the humanized registry key during compilation. */
  readonly label?: string;
  /** Collection UI label; defaults to the singular label without inflection. */
  readonly pluralLabel?: string;
  /** Explanatory text for people, documentation, and agents. */
  readonly description?: string;
  readonly membership: Membership;
  readonly properties: Readonly<Record<string, Property>>;
}

export type BoundProperty<
  P extends Property = Property,
  Owner extends ObjectDefinition = ObjectDefinition,
> = P & { readonly owner: Owner };

export type DefinedObject<
  Id extends string,
  P extends Record<string, Property>,
  M extends Membership = Membership,
> = Omit<ObjectDefinition, 'id' | 'properties' | 'membership'> & {
  readonly id: Id;
  readonly membership: M;
  readonly properties: {
    readonly [K in keyof P]: BoundProperty<
      Omit<P[K], 'owner'>,
      DefinedObject<Id, P, M>
    >;
  };
};

export function defineObject<
  const Id extends string,
  const P extends Record<string, Property>,
  const M extends Membership,
>(
  definition: Omit<ObjectDefinition, 'id' | 'properties' | 'membership'> & {
    id: Id;
    membership: M;
    properties: P;
  },
): DefinedObject<Id, P, M> {
  const identities = Object.values(definition.properties).filter(
    (p) => p.origin.kind === 'object-id',
  ).length;

  // The registry key is unknown here; the issue names the supplied object ID only.
  if (identities !== 1)
    throw new CompileError([
      {
        code: 'object.object-id-count',
        message: `Object '${definition.id}' requires exactly one objectId() property; found ${identities}`,
        definitionId: definition.id,
        path: { root: 'definition', segments: ['properties'] },
      },
    ]);

  const object = {
    ...definition,
    properties: {} as Record<string, Property>,
  };

  object.properties = Object.freeze(
    Object.fromEntries(
      Object.entries(definition.properties).map(([name, property]) => [
        name,
        // Keep the owner back-reference out of enumeration and serialization.
        Object.freeze(
          Object.defineProperty({ ...property }, 'owner', { value: object }),
        ),
      ]),
    ),
  );

  return recordProvenance(Object.freeze(object)) as DefinedObject<Id, P, M>;
}

export interface Traversal {
  readonly name: string;
  readonly cardinality: 'one' | 'many';
  readonly description?: string;
}

type TraversalInput<Name extends string> =
  Name | { readonly name: Name; readonly description?: string };

export type RelationshipDefinition<
  From extends ObjectDefinition = ObjectDefinition,
  To extends ObjectDefinition = ObjectDefinition,
  Forward extends Traversal = Traversal,
  Reverse extends Traversal = Traversal,
> = {
  readonly id: string;
  readonly from: From;
  readonly to: To;
  readonly forward: Forward;
  readonly reverse: Reverse;
} & (
  | {
      readonly via: BoundProperty<ReferenceProperty<From['id'], From>, To>;
      readonly through?: never;
    }
  | {
      readonly via?: never;
      readonly through: {
        readonly from: BoundProperty<ReferenceProperty<From['id'], From>>;
        readonly to: BoundProperty<ReferenceProperty<To['id'], To>>;
      };
    }
);

export function defineRelationship<
  Via extends BoundProperty<ReferenceProperty>,
  const Forward extends string,
  const Reverse extends string,
>(definition: {
  id: string;
  forward: TraversalInput<Forward>;
  reverse: TraversalInput<Reverse>;
  via: Via;
  through?: never;
}): RelationshipDefinition<
  Via['target'],
  Via['owner'],
  {
    readonly name: Forward;
    readonly cardinality: 'many';
    readonly description?: string;
  },
  {
    readonly name: Reverse;
    readonly cardinality: 'one';
    readonly description?: string;
  }
> & { readonly via: Via; readonly through?: never };

export function defineRelationship<
  From extends BoundProperty<ReferenceProperty>,
  To extends BoundProperty<ReferenceProperty, From['owner']>,
  const Forward extends string,
  const Reverse extends string,
>(definition: {
  id: string;
  forward: TraversalInput<Forward>;
  reverse: TraversalInput<Reverse>;
  via?: never;
  through: { from: From; to: To };
}): RelationshipDefinition<
  From['target'],
  To['target'],
  {
    readonly name: Forward;
    readonly cardinality: 'many';
    readonly description?: string;
  },
  {
    readonly name: Reverse;
    readonly cardinality: 'many';
    readonly description?: string;
  }
> & {
  readonly via?: never;
  readonly through: { readonly from: From; readonly to: To };
};

export function defineRelationship(definition: {
  id: string;
  forward: TraversalInput<string>;
  reverse: TraversalInput<string>;
  via?: BoundProperty<ReferenceProperty>;
  through?: {
    from: BoundProperty<ReferenceProperty>;
    to: BoundProperty<ReferenceProperty>;
  };
}): RelationshipDefinition {
  if (Boolean(definition.via) === Boolean(definition.through))
    throw new Error('A relationship requires exactly one of via or through');

  const traversal = (
    input: TraversalInput<string>,
    cardinality: 'one' | 'many',
  ) =>
    Object.freeze({
      ...(typeof input === 'string' ? { name: input } : input),
      cardinality,
    });

  if (definition.through) {
    const { from, to } = definition.through;

    return recordProvenance(
      Object.freeze({
        id: definition.id,
        from: from.target,
        to: to.target,
        through: Object.freeze({ from, to }),
        forward: traversal(definition.forward, 'many'),
        reverse: traversal(definition.reverse, 'many'),
      }),
    );
  }

  const via = definition.via!;

  return recordProvenance(
    Object.freeze({
      id: definition.id,
      from: via.target,
      to: via.owner,
      via,
      forward: traversal(definition.forward, 'many'),
      reverse: traversal(definition.reverse, 'one'),
    }),
  );
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
  /** Explanatory text for people, documentation, and agents. */
  readonly description?: string;
  readonly objects: ObjectRegistry;
  readonly relationships?: RelationshipRegistry;
  readonly actions?: Readonly<Record<string, ActionDefinition>>;
  readonly access: AccessDefinition;
  readonly policies: Readonly<Record<string, Policy>>;
}

export function defineGraph<const G extends GraphDefinition>(
  graph: G & {
    readonly policies: Policies<NoInfer<G['objects']>, NoInfer<G['access']>> &
      ExactPolicyInput<
        G['policies'],
        Policies<NoInfer<G['objects']>, NoInfer<G['access']>>
      >;
  },
): G {
  return recordProvenance(graph);
}

export { defineAccess } from './authorization.js';
export { assertFields } from './results.js';

export type {
  AccessDefinition,
  Claim,
  FieldGroup,
  Policy,
  Policies,
  PolicyWhere,
  RoleGate,
} from './authorization.js';

export { defineAction, implementAction } from './actions.js';

export type {
  ActionDefinition,
  ActionImplementation,
  ActionContext,
  NativeValues,
  Receipt,
  ActionRequest,
} from './actions.js';

export type {
  ObjectResult,
  ReadOptions,
  ObjectRecord,
  QueryOptions,
  PageOptions,
  QueryResult,
} from './operations.js';

export {
  definitionProvenance,
  disableDefinitionProvenance,
  enableDefinitionProvenance,
} from './provenance.js';

export { CompileError } from './diagnostics.js';

export type {
  IssuePath,
  ModelIssue,
  ModelIssueCode,
  SourceSite,
} from './diagnostics.js';

export { connect, defineApp, isAppDefinition } from './app.js';

export type {
  Connection,
  AppBindings,
  AppDefinition,
  AppSetupContext,
} from './app.js';
