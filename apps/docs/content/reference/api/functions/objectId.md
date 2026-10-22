# Function: objectId()

```ts
function objectId<Id>(options): ObjectIdProperty & {
  id: Id;
};
```

Defined in: [packages/relate/src/index.ts:146](https://github.com/relatehq/relate/blob/main/packages/relate/src/index.ts#L146)

## Type Parameters

| Type Parameter |
| ------ |
| `Id` *extends* `string` |

## Parameters

| Parameter | Type |
| ------ | ------ |
| `options` | \{ `access?`: `FieldGroup`\<`"ordinary"`\>; `description?`: `string`; `id`: `Id`; \} |
| `options.access?` | `FieldGroup`\<`"ordinary"`\> |
| `options.description?` | `string` |
| `options.id` | `Id` |

## Returns

`ObjectIdProperty` & \{
  `id`: `Id`;
\}
