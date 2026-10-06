import type { z } from 'zod';
import type { ObjectDefinition, Property } from './index.js';

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
    readonly where?: Equality;
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
