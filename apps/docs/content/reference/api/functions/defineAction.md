# Function: defineAction()

```ts
function defineAction<Id, Input, Output, Creates, Errors>(definition): ActionDefinition<Input, Output, Creates, Errors> & {
  id: Id;
};
```

Defined in: [packages/relate/src/actions.ts:59](https://github.com/relatehq/relate/blob/main/packages/relate/src/actions.ts#L59)

Synchronous native action with optional declared business failures.

## Type Parameters

| Type Parameter | Default type |
| ------ | ------ |
| `Id` *extends* `string` | - |
| `Input` *extends* `ZodType`\<`unknown`, `unknown`, `$ZodTypeInternals`\<`unknown`, `unknown`\>\> | - |
| `Output` *extends* `ZodType`\<`unknown`, `unknown`, `$ZodTypeInternals`\<`unknown`, `unknown`\>\> | - |
| `Creates` *extends* readonly `NativeObject`[] | - |
| `Errors` *extends* `Readonly`\<`Record`\<`string`, `ZodType`\<`unknown`, `unknown`, `$ZodTypeInternals`\<`unknown`, `unknown`\>\>\>\> | \{ \} |

## Parameters

| Parameter | Type |
| ------ | ------ |
| `definition` | \{ `creates`: `Creates`; `description?`: `string`; `errors?`: `Errors`; `id`: `Id`; `input`: `Input`; `output`: `Output`; `policy?`: \{ `execute`: `RoleGate`; \}; \} |
| `definition.creates` | `Creates` |
| `definition.description?` | `string` |
| `definition.errors?` | `Errors` |
| `definition.id` | `Id` |
| `definition.input` | `Input` |
| `definition.output` | `Output` |
| `definition.policy?` | \{ `execute`: `RoleGate`; \} |
| `definition.policy.execute` | `RoleGate` |

## Returns

`ActionDefinition`\<`Input`, `Output`, `Creates`, `Errors`\> & \{
  `id`: `Id`;
\}
