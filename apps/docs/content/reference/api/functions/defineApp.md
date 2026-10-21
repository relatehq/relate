# Function: defineApp()

```ts
function defineApp<G>(definition): AppDefinition<G>;
```

Defined in: [packages/relate/src/app.ts:213](https://github.com/relatehq/relate/blob/main/packages/relate/src/app.ts#L213)

## Type Parameters

| Type Parameter |
| ------ |
| `G` *extends* `Graph` |

## Parameters

| Parameter | Type |
| ------ | ------ |
| `definition` | \{ `graph`: `G`; `setup?`: (`context`) => `AppBindings`\<`G`\> \| `Promise`\<`AppBindings`\<`G`\>\>; \} |
| `definition.graph` | `G` |
| `definition.setup?` | (`context`) => `AppBindings`\<`G`\> \| `Promise`\<`AppBindings`\<`G`\>\> |

## Returns

`AppDefinition`\<`G`\>
