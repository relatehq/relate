# Function: defineAccess()

```ts
function defineAccess<R, G, C>(definition): Readonly<{
  actor: Readonly<{
     id: Readonly<{
        kind: "actor-field";
        name: "id";
     }>;
  }>;
  claims: Readonly<{ readonly [K in string | number | symbol]: Claim<C[K]> }>;
  fieldGroups: readonly G[number][];
  groups: Readonly<{ readonly [K in string]: FieldGroup<K> }>;
  roles: readonly R[number][];
  role: RoleGate<R[number]>;
}>;
```

Defined in: [packages/relate/src/authorization.ts:171](https://github.com/relatehq/relate/blob/main/packages/relate/src/authorization.ts#L171)

Declare the vocabulary once; hosts still supply authenticated principals.

## Type Parameters

| Type Parameter |
| ------ |
| `R` *extends* readonly `string`[] |
| `G` *extends* readonly `string`[] |
| `C` *extends* `Record`\<`string`, `ZodType`\<`unknown`, `unknown`, `$ZodTypeInternals`\<`unknown`, `unknown`\>\>\> |

## Parameters

| Parameter | Type |
| ------ | ------ |
| `definition` | \{ `claims`: `C`; `fieldGroups`: `G`; `roles`: `R`; \} |
| `definition.claims` | `C` |
| `definition.fieldGroups` | `G` |
| `definition.roles` | `R` |

## Returns

`Readonly`\<\{
  `actor`: `Readonly`\<\{
     `id`: `Readonly`\<\{
        `kind`: `"actor-field"`;
        `name`: `"id"`;
     \}\>;
  \}\>;
  `claims`: `Readonly`\<\{ readonly \[K in string \| number \| symbol\]: Claim\<C\[K\]\> \}\>;
  `fieldGroups`: readonly `G`\[`number`\][];
  `groups`: `Readonly`\<`{ readonly [K in string]: FieldGroup<K> }`\>;
  `roles`: readonly `R`\[`number`\][];
  `role`: `RoleGate`\<`R`\[`number`\]\>;
\}\>
