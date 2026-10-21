import type { z } from 'zod';
import type { DatasetRegistry } from './datasets.js';
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

export interface ActorField {
  readonly kind: 'actor-field';
  readonly name: 'id';
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
  ]?: O['properties'][K]['origin']['kind'] extends 'computed'
    ? never
    : O['properties'][K] extends ReferenceProperty<infer Id>
      ? PolicyWhere<Registry, Extract<Registry[keyof Registry], { id: Id }>>
      : {
          readonly eq:
            | Claim<z.ZodType<z.output<O['properties'][K]['schema']>>>
            | (z.output<O['properties'][K]['schema']> extends string
                ? ActorField
                : never);
        };
};

/** Reject surplus extracted keys as well as fresh literal typos. */
export type ExactPolicyInput<Input, Shape> = Shape extends Claim | ActorField
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
  A extends string = string,
> =
  | {
      readonly read: 'deny';
      readonly groups?: never;
      readonly create?: ObjectRule<R, W> | 'deny';
      readonly datasets?: Readonly<Record<A, { readonly gate: RoleGate<R> }>>;
    }
  | {
      readonly read: ObjectRule<R, W>;
      readonly create?: ObjectRule<R, W> | 'deny';
      readonly datasets?: Readonly<Record<A, { readonly gate: RoleGate<R> }>>;
      readonly groups?: Readonly<
        Partial<Record<Exclude<G, 'ordinary'>, RoleGate<R>>>
      > & { readonly ordinary?: never };
    };

export type Policies<
  Registry extends ObjectRegistry,
  Access extends AccessDefinition,
  Datasets extends DatasetRegistry = {},
> = {
  readonly [K in keyof Registry]: Policy<
    Access['roles'][number],
    Access['fieldGroups'][number],
    PolicyWhere<Registry, Registry[K]>,
    Extract<keyof NonNullable<Registry[K]['datasets']>, string>
  > & {
    readonly create?: Registry[K]['membership'] extends { kind: 'native' }
      ? | ObjectRule<
            Access['roles'][number],
            PolicyWhere<Registry, Registry[K]>
          >
        | 'deny'
      : never;
  } & (keyof NonNullable<Registry[K]['datasets']> extends never
      ? {}
      : {
          readonly datasets: {
            readonly [A in keyof NonNullable<Registry[K]['datasets']>]: {
              readonly gate: RoleGate<Access['roles'][number]>;
            };
          };
        });
} & {
  readonly [K in keyof Datasets]: DatasetPolicy<
    Access['roles'][number],
    Access['fieldGroups'][number]
  >;
};

export interface DatasetPolicy<
  R extends string = string,
  G extends string = string,
> {
  readonly groups?: Readonly<
    Partial<Record<Exclude<G, 'ordinary'>, RoleGate<R>>>
  > & { readonly ordinary?: never };
}

/** A claim value as the runtime receives it from an authenticated host. */
export type ClaimValue = string | number | boolean | null;

/**
 * A named development identity: inert outside `relate dev`, never part of the
 * Manifest or `definitionRevision`. Roles and claims use the access vocabulary.
 */
export interface PrincipalDefinition<
  Access extends AccessDefinition = AccessDefinition,
> {
  readonly roles: readonly Access['roles'][number][];
  readonly claims?: {
    readonly [K in keyof Access['claims']]?: z.input<
      Access['claims'][K]['schema']
    > &
      ClaimValue;
  };
}

export type Principals<Access extends AccessDefinition = AccessDefinition> =
  Readonly<Record<string, PrincipalDefinition<Access>>>;

/** A validated development principal; the runtime principal is `{ id: name, ...this }`. */
export interface DevelopmentPrincipal {
  readonly roles: readonly string[];
  readonly claims: Readonly<Record<string, ClaimValue>>;
}

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
    actor: Object.freeze({
      id: Object.freeze({ kind: 'actor-field' as const, name: 'id' as const }),
    }),
    roles: Object.freeze([...definition.roles]),
    fieldGroups: Object.freeze([...definition.fieldGroups]),
    claims: Object.freeze(claims),
    groups: Object.freeze(groups),
    role(role: R[number]): RoleGate<R[number]> {
      return Object.freeze({ kind: 'role', role });
    },
  });
}
