import type { z } from 'zod';
import type {
  ObjectDefinition,
  ObjectRegistry,
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

/** Reject surplus extracted keys as well as fresh literal typos. */
export type ExactPolicyInput<Input, Shape> = Shape extends Claim
  ? Input
  : Input extends object
    ? Shape extends object
      ? {
          [K in keyof Input]: K extends keyof Shape
            ? ExactPolicyInput<Input[K], NonNullable<Shape[K]>>
            : never;
        }
      : never
    : Input;

export type ObjectRule<R extends string, W> =
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

export interface AccessDefinition {
  readonly roles: readonly string[];
  readonly claims: Readonly<Record<string, Claim>>;
  readonly fieldGroups: readonly string[];
}

export type Policy<
  R extends string = string,
  G extends string = string,
  W = unknown,
> =
  | { readonly read: 'deny'; readonly groups?: never }
  | {
      readonly read: ObjectRule<R, W>;
      readonly groups?: Readonly<
        Partial<Record<Exclude<G, 'ordinary'>, RoleGate<R>>>
      > & { readonly ordinary?: never };
    };

export type Policies<
  Registry extends ObjectRegistry,
  Access extends AccessDefinition,
> = {
  readonly [K in keyof Registry]: Policy<
    Access['roles'][number],
    Access['fieldGroups'][number],
    PolicyWhere<Registry, Registry[K]>
  >;
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
  });
}
