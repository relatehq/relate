# Function: defineObject()

```ts
function defineObject<Id, P, M>(definition): DefinedObject<Id, P, M>;
```

Defined in: [packages/relate/src/index.ts:304](https://github.com/relatehq/relate/blob/main/packages/relate/src/index.ts#L304)

## Type Parameters

| Type Parameter |
| ------ |
| `Id` *extends* `string` |
| `P` *extends* `Record`\<`string`, `Property`\<`ZodType`\<`unknown`, `unknown`, `$ZodTypeInternals`\<`unknown`, `unknown`\>\>\>\> |
| `M` *extends* `Membership` |

## Parameters

| Parameter | Type |
| ------ | ------ |
| `definition` | `Omit`\<`ObjectDefinition`, `"id"` \| `"properties"` \| `"membership"`\> & \{ `id`: `Id`; `membership`: `M`; `properties`: `P`; \} |

## Returns

`DefinedObject`\<`Id`, `P`, `M`\>
