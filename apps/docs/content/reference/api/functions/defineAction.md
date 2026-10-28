# Function: defineAction()

```ts
function defineAction<Id, Input, Output, Creates, Errors, Adopts>(definition): ActionDefinition<Input, Output, Creates, Errors, Adopts> & {
  id: Id;
};
```

Defined in: [packages/relate/src/actions.ts:68](https://github.com/relatehq/relate/blob/main/packages/relate/src/actions.ts#L68)

Synchronous native action with optional declared business failures.

## Type Parameters

| Type Parameter | Default type |
| ------ | ------ |
| `Id` *extends* `string` | - |
| `Input` *extends* `ZodType`\<`unknown`, `unknown`, `$ZodTypeInternals`\<`unknown`, `unknown`\>\> | - |
| `Output` *extends* `ZodType`\<`unknown`, `unknown`, `$ZodTypeInternals`\<`unknown`, `unknown`\>\> | - |
| `Creates` *extends* readonly `NativeObject`[] | readonly \[\] |
| `Errors` *extends* `Readonly`\<`Record`\<`string`, `ZodType`\<`unknown`, `unknown`, `$ZodTypeInternals`\<`unknown`, `unknown`\>\>\>\> | \{ \} |
| `Adopts` *extends* readonly `SourceObject`[] | readonly \[\] |

## Parameters

| Parameter | Type |
| ------ | ------ |
| `definition` | \{ `adopts?`: `Adopts`; `creates?`: `Creates`; `description?`: `string`; `errors?`: `Errors`; `id`: `Id`; `input`: `Input`; `output`: `Output`; `policy?`: \{ `execute`: `RoleGate`; \}; \} |
| `definition.adopts?` | `Adopts` |
| `definition.creates?` | `Creates` |
| `definition.description?` | `string` |
| `definition.errors?` | `Errors` |
| `definition.id` | `Id` |
| `definition.input` | `Input` |
| `definition.output` | `Output` |
| `definition.policy?` | \{ `execute`: `RoleGate`; \} |
| `definition.policy.execute` | `RoleGate` |

## Returns

`ActionDefinition`\<`Input`, `Output`, `Creates`, `Errors`, `Adopts`\> & \{
  `id`: `Id`;
\}
