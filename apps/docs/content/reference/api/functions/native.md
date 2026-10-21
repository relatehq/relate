# Function: native()

```ts
function native<S, Id>(schema, options): Property<S> & {
  id: Id;
  origin: {
     kind: "native";
  };
};
```

Defined in: [packages/relate/src/index.ts:158](https://github.com/relatehq/relate/blob/main/packages/relate/src/index.ts#L158)

## Type Parameters

| Type Parameter |
| ------ |
| `S` *extends* `ZodType`\<`unknown`, `unknown`, `$ZodTypeInternals`\<`unknown`, `unknown`\>\> |
| `Id` *extends* `string` |

## Parameters

| Parameter | Type |
| ------ | ------ |
| `schema` | `S` |
| `options` | \{ `access?`: `FieldGroup`\<`string`\>; `description?`: `string`; `id`: `Id`; \} |
| `options.access?` | `FieldGroup`\<`string`\> |
| `options.description?` | `string` |
| `options.id` | `Id` |

## Returns

`Property`\<`S`\> & \{
  `id`: `Id`;
  `origin`: \{
     `kind`: `"native"`;
  \};
\}
