import type { z } from 'zod';
import type {
  ObjectDefinition,
  ObjectRegistry,
  Property,
  ReferenceProperty,
} from './index.js';

export interface FieldGroup<Name extends string = string> {
  readonly kind: 'field-group';
  readonly name: Name;
}

export interface Claim<S extends z.ZodType = z.ZodType> {
  readonly kind: 'claim';
  readonly name: string;
  readonly schema: S;
}

export interface RoleGate<Role extends string = string> {
  readonly kind: 'role';
  readonly role: Role;
}

export interface Equality<P extends Property = Property> {
  readonly kind: 'equals';
  readonly property: P;
  readonly claim: Claim;
}

export interface PathConditions {
  readonly kind: 'all';
  readonly conditions: readonly {
    readonly path: readonly Property[];
    readonly claim: Claim;
  }[];
}

export type PolicyWhere<
  Registry extends ObjectRegistry,
  O extends ObjectDefinition,
> = {
  readonly [
    K in keyof O['properties']
  ]?: O['properties'][K] extends ReferenceProperty<infer Id>
    ? PolicyWhere<Registry, Extract<Registry[keyof Registry], { id: Id }>>
    : { readonly eq: Claim<z.ZodType<z.output<O['properties'][K]['schema']>>> };
};

type ExactPolicyWhere<W, Shape> = {
  [K in keyof W]: K extends keyof Shape
    ? K extends 'eq'
      ? W[K]
      : ExactPolicyWhere<W[K], NonNullable<Shape[K]>>
    : never;
};

type ObjectRule<R extends string, W> =
  | {
      readonly gate: RoleGate<R>;
      readonly where?: never;
      readonly evidenceMaxAgeMs?: never;
    }
  | {
      readonly gate: RoleGate<R>;
      readonly where: W;
      readonly evidenceMaxAgeMs: number;
    };

function paths(
  objects: ObjectRegistry,
  object: ObjectDefinition,
  input: unknown,
  path: readonly Property[] = [],
): PathConditions['conditions'] {
  if (
    !input ||
    typeof input !== 'object' ||
    Array.isArray(input) ||
    !Object.keys(input).length ||
    path.length >= 16
  )
    throw new Error('Invalid policy predicate');

  return Object.entries(input).flatMap(([name, value]) => {
    const property = Object.hasOwn(object.properties, name)
      ? object.properties[name]
      : undefined;

    if (!property) throw new Error('Unknown policy dependency');

    const next = [...path, property];

    if (property.origin.kind === 'reference') {
      const targetId = property.origin.targetObjectDefinitionId;
      const target = Object.values(objects).find((o) => o.id === targetId);

      if (!target)
        throw new Error('Unknown reference target in policy registry');

      return paths(objects, target, value, next);
    }

    if (
      !value ||
      typeof value !== 'object' ||
      Object.keys(value).length !== 1 ||
      !('eq' in value) ||
      !value.eq ||
      typeof value.eq !== 'object' ||
      !('kind' in value.eq) ||
      value.eq.kind !== 'claim'
    )
      throw new Error('Invalid policy predicate');

    return [{ path: next, claim: value.eq as Claim }];
  });
}

// Infer the property first: a claim cannot widen its accepted value type.
export function equals<P extends Property>(
  property: P,
  claim: Claim<z.ZodType<NoInfer<z.output<P['schema']>>>>,
): Equality<P> {
  return Object.freeze({ kind: 'equals', property, claim });
}

export interface AccessDefinition {
  readonly roles: readonly string[];
  readonly claims: Readonly<Record<string, Claim>>;
  readonly fieldGroups: readonly string[];
}

export interface Policy<O extends ObjectDefinition = ObjectDefinition> {
  readonly object: O;
  readonly read: {
    readonly gate: RoleGate;
    readonly where?: Equality | PathConditions;
    readonly evidenceMaxAgeMs: number;
  };
  readonly groups: Readonly<Record<string, RoleGate>>;
}

type PolicyRules<
  O extends ObjectDefinition,
  R extends string,
  G extends string,
> = {
  readonly read: {
    readonly gate: RoleGate<R>;
    readonly where?: Equality<O['properties'][keyof O['properties']]>;
    readonly evidenceMaxAgeMs: number;
  };
  readonly groups?: Readonly<
    Partial<Record<Exclude<G, 'ordinary'>, RoleGate<R>>>
  > & { readonly ordinary?: never };
};

/** Declare the vocabulary once; hosts still supply authenticated principals. */
export function defineAccess<
  const R extends readonly string[],
  const G extends readonly string[],
  C extends Record<string, z.ZodType>,
>(definition: { roles: R; fieldGroups: G; claims: C }) {
  const claims = Object.fromEntries(
    Object.entries(definition.claims).map(([name, schema]) => [
      name,
      Object.freeze({ kind: 'claim' as const, name, schema }),
    ]),
  ) as { readonly [K in keyof C]: Claim<C[K]> };
  const groups = Object.fromEntries(
    definition.fieldGroups.map((name) => [
      name,
      Object.freeze({ kind: 'field-group' as const, name }),
    ]),
  ) as { readonly [K in G[number]]: FieldGroup<K> };

  return Object.freeze({
    roles: Object.freeze([...definition.roles]),
    fieldGroups: Object.freeze([...definition.fieldGroups]),
    claims: Object.freeze(claims),
    groups: Object.freeze(groups),
    role(role: R[number]): RoleGate<R[number]> {
      return Object.freeze({ kind: 'role', role });
    },
    forObjects<Registry extends ObjectRegistry>(objects: Registry) {
      const registry = Object.freeze({ ...objects });

      return Object.freeze({
        policy<
          O extends Registry[keyof Registry],
          const W extends PolicyWhere<Registry, NoInfer<O>>,
        >(
          object: O,
          rules: {
            read: ObjectRule<
              R[number],
              W & ExactPolicyWhere<W, PolicyWhere<Registry, NoInfer<O>>>
            >;
            groups?: Readonly<
              Partial<
                Record<Exclude<G[number], 'ordinary'>, RoleGate<R[number]>>
              >
            > & { readonly ordinary?: never };
          },
        ): Policy<O> {
          if (!Object.values(registry).includes(object))
            throw new Error('Unregistered policy object');

          const hasWhere = Object.hasOwn(rules.read, 'where');

          if (
            hasWhere
              ? typeof rules.read.evidenceMaxAgeMs !== 'number'
              : rules.read.evidenceMaxAgeMs !== undefined
          )
            throw new Error(
              'Predicates require an evidence bound; role-only rules omit it',
            );

          return Object.freeze({
            object,
            read: Object.freeze({
              gate: rules.read.gate,
              ...(hasWhere
                ? {
                    where: Object.freeze({
                      kind: 'all' as const,
                      conditions: paths(registry, object, rules.read.where),
                    }),
                  }
                : {}),
              evidenceMaxAgeMs: rules.read.evidenceMaxAgeMs ?? 0,
            }),
            groups: Object.freeze({ ...rules.groups }),
          });
        },
      });
    },
    policy<O extends ObjectDefinition>(
      object: O,
      rules: PolicyRules<NoInfer<O>, R[number], G[number]>,
    ): Policy<O> {
      return Object.freeze({
        object,
        read: Object.freeze({ ...rules.read }),
        groups: Object.freeze({ ...rules.groups }),
      });
    },
  });
}
