# Function: reference()

## Call Signature

```ts
function reference<O, Id>(target, options): ReferenceProperty<O["id"], O> & {
  id: Id;
  origin: {
     field: string;
     kind: "reference";
     sourceDefinitionId: string;
     targetObjectDefinitionId: O["id"];
  };
};
```

Defined in: [packages/relate/src/index.ts:206](https://github.com/relatehq/relate/blob/main/packages/relate/src/index.ts#L206)

### Type Parameters

| Type Parameter |
| ------ |
| `O` *extends* `ObjectDefinition` |
| `Id` *extends* `string` |

### Parameters

| Parameter | Type |
| ------ | ------ |
| `target` | `O` |
| `options` | \{ `access?`: `FieldGroup`\<`string`\>; `description?`: `string`; `from`: `FieldReference`\<`ZodString`\>; `id`: `Id`; \} |
| `options.access?` | `FieldGroup`\<`string`\> |
| `options.description?` | `string` |
| `options.from` | `FieldReference`\<`ZodString`\> |
| `options.id` | `Id` |

### Returns

`ReferenceProperty`\<`O`\[`"id"`\], `O`\> & \{
  `id`: `Id`;
  `origin`: \{
     `field`: `string`;
     `kind`: `"reference"`;
     `sourceDefinitionId`: `string`;
     `targetObjectDefinitionId`: `O`\[`"id"`\];
  \};
\}

## Call Signature

```ts
function reference<O, Id>(target, options): ReferenceProperty<O["id"], O> & {
  id: Id;
  origin: {
     kind: "native-reference";
     targetObjectDefinitionId: O["id"];
  };
};
```

Defined in: [packages/relate/src/index.ts:222](https://github.com/relatehq/relate/blob/main/packages/relate/src/index.ts#L222)

### Type Parameters

| Type Parameter |
| ------ |
| `O` *extends* `ObjectDefinition` |
| `Id` *extends* `string` |

### Parameters

| Parameter | Type |
| ------ | ------ |
| `target` | `O` |
| `options` | \{ `access?`: `FieldGroup`\<`string`\>; `description?`: `string`; `id`: `Id`; \} |
| `options.access?` | `FieldGroup`\<`string`\> |
| `options.description?` | `string` |
| `options.id` | `Id` |

### Returns

`ReferenceProperty`\<`O`\[`"id"`\], `O`\> & \{
  `id`: `Id`;
  `origin`: \{
     `kind`: `"native-reference"`;
     `targetObjectDefinitionId`: `O`\[`"id"`\];
  \};
\}
