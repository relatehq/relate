# Function: defineDataset()

```ts
function defineDataset<C>(definition): DatasetDefinition<C>;
```

Defined in: [packages/relate/src/datasets.ts:25](https://github.com/relatehq/relate/blob/main/packages/relate/src/datasets.ts#L25)

Declare an unbound row contract; the columns are the only schema input.

## Type Parameters

| Type Parameter |
| ------ |
| `C` *extends* `Readonly`\<`Record`\<`string`, `DatasetColumn`\<`ZodType`\<`unknown`, `unknown`, `$ZodTypeInternals`\<`unknown`, `unknown`\>\>\>\>\> |

## Parameters

| Parameter | Type |
| ------ | ------ |
| `definition` | \{ `columns`: `C`; `description?`: `string`; `id`: `string`; `schema?`: `undefined`; \} |
| `definition.columns` | `C` |
| `definition.description?` | `string` |
| `definition.id` | `string` |
| `definition.schema?` | `undefined` |

## Returns

`DatasetDefinition`\<`C`\>
