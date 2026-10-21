# Function: defineObject()

```ts
function defineObject<Id, P, M, D>(definition): DefinedObject<Id, P, M, D>;
```

Defined in: [packages/relate/src/index.ts:314](https://github.com/relatehq/relate/blob/main/packages/relate/src/index.ts#L314)

## Type Parameters

| Type Parameter | Default type |
| ------ | ------ |
| `Id` *extends* `string` | - |
| `P` *extends* `Record`\<`string`, `Property`\<`ZodType`\<`unknown`, `unknown`, `$ZodTypeInternals`\<`unknown`, `unknown`\>\>\>\> | - |
| `M` *extends* `Membership` | - |
| `D` *extends* `Readonly`\<`Record`\<`string`, `DatasetAssociation`\<`DatasetDefinition`\<`Readonly`\<`Record`\<`string`, `DatasetColumn`\<`ZodType`\<`unknown`, `unknown`, `$ZodTypeInternals`\<`unknown`, `unknown`\>\>\>\>\>\>\>\>\> | \{ \} |

## Parameters

| Parameter | Type |
| ------ | ------ |
| `definition` | `Omit`\<`ObjectDefinition`, `"id"` \| `"properties"` \| `"membership"` \| `"datasets"`\> & \{ `datasets?`: `D` & `CheckedAssociations`\<`NoInfer`\<`P`\>, `NoInfer`\<`D`\>\>; `id`: `Id`; `membership`: `M`; `properties`: `P`; \} |

## Returns

`DefinedObject`\<`Id`, `P`, `M`, `D`\>
