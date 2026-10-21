# Function: from()

```ts
function from<S, Id>(field, options): Property<S> & {
  id: Id;
};
```

Defined in: [packages/relate/src/index.ts:171](https://github.com/relatehq/relate/blob/main/packages/relate/src/index.ts#L171)

## Type Parameters

| Type Parameter |
| ------ |
| `S` *extends* `ZodType`\<`unknown`, `unknown`, `$ZodTypeInternals`\<`unknown`, `unknown`\>\> |
| `Id` *extends* `string` |

## Parameters

| Parameter | Type |
| ------ | ------ |
| `field` | `FieldReference`\<`S`\> |
| `options` | \{ `access?`: `FieldGroup`\<`string`\>; `description?`: `string`; `id`: `Id`; \} |
| `options.access?` | `FieldGroup`\<`string`\> |
| `options.description?` | `string` |
| `options.id` | `Id` |

## Returns

`Property`\<`S`\> & \{
  `id`: `Id`;
\}
