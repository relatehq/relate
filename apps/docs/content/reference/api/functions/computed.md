# Function: computed()

```ts
function computed<Id>(options): ComputedProperty & {
  id: Id;
};
```

Defined in: [packages/relate/src/computed.ts:15](https://github.com/relatehq/relate/blob/main/packages/relate/src/computed.ts#L15)

Declare a read-only analytical property whose derived value is never persisted.

## Type Parameters

| Type Parameter |
| ------ |
| `Id` *extends* `string` |

## Parameters

| Parameter | Type |
| ------ | ------ |
| `options` | \{ `access?`: `FieldGroup`\<`string`\>; `description?`: `string`; `id`: `Id`; `sql`: `string`; \} |
| `options.access?` | `FieldGroup`\<`string`\> |
| `options.description?` | `string` |
| `options.id` | `Id` |
| `options.sql` | `string` |

## Returns

`ComputedProperty` & \{
  `id`: `Id`;
\}
