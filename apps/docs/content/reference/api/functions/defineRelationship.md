# Function: defineRelationship()

## Call Signature

```ts
function defineRelationship<Via, Forward, Reverse>(definition): RelationshipDefinition<Via["target"], Via["owner"], {
  cardinality: "many";
  description?: string;
  name: Forward;
}, {
  cardinality: "one";
  description?: string;
  name: Reverse;
}> & {
  through?: undefined;
  via: Via;
};
```

Defined in: [packages/relate/src/index.ts:403](https://github.com/relatehq/relate/blob/main/packages/relate/src/index.ts#L403)

### Type Parameters

| Type Parameter |
| ------ |
| `Via` *extends* `BoundProperty`\<`ReferenceProperty`\<`string`, `ObjectDefinition`\>, `ObjectDefinition`\> |
| `Forward` *extends* `string` |
| `Reverse` *extends* `string` |

### Parameters

| Parameter | Type |
| ------ | ------ |
| `definition` | \{ `forward`: `TraversalInput`\<`Forward`\>; `id`: `string`; `reverse`: `TraversalInput`\<`Reverse`\>; `through?`: `undefined`; `via`: `Via`; \} |
| `definition.forward` | `TraversalInput`\<`Forward`\> |
| `definition.id` | `string` |
| `definition.reverse` | `TraversalInput`\<`Reverse`\> |
| `definition.through?` | `undefined` |
| `definition.via` | `Via` |

### Returns

`RelationshipDefinition`\<`Via`\[`"target"`\], `Via`\[`"owner"`\], \{
  `cardinality`: `"many"`;
  `description?`: `string`;
  `name`: `Forward`;
\}, \{
  `cardinality`: `"one"`;
  `description?`: `string`;
  `name`: `Reverse`;
\}\> & \{
  `through?`: `undefined`;
  `via`: `Via`;
\}

## Call Signature

```ts
function defineRelationship<From, To, Forward, Reverse>(definition): RelationshipDefinition<From["target"], To["target"], {
  cardinality: "many";
  description?: string;
  name: Forward;
}, {
  cardinality: "many";
  description?: string;
  name: Reverse;
}> & {
  through: {
     from: From;
     to: To;
  };
  via?: undefined;
};
```

Defined in: [packages/relate/src/index.ts:428](https://github.com/relatehq/relate/blob/main/packages/relate/src/index.ts#L428)

### Type Parameters

| Type Parameter |
| ------ |
| `From` *extends* `BoundProperty`\<`ReferenceProperty`\<`string`, `ObjectDefinition`\>, `ObjectDefinition`\> |
| `To` *extends* `BoundProperty`\<`ReferenceProperty`\<`string`, `ObjectDefinition`\>, `From`\[`"owner"`\]\> |
| `Forward` *extends* `string` |
| `Reverse` *extends* `string` |

### Parameters

| Parameter | Type |
| ------ | ------ |
| `definition` | \{ `forward`: `TraversalInput`\<`Forward`\>; `id`: `string`; `reverse`: `TraversalInput`\<`Reverse`\>; `through`: \{ `from`: `From`; `to`: `To`; \}; `via?`: `undefined`; \} |
| `definition.forward` | `TraversalInput`\<`Forward`\> |
| `definition.id` | `string` |
| `definition.reverse` | `TraversalInput`\<`Reverse`\> |
| `definition.through` | \{ `from`: `From`; `to`: `To`; \} |
| `definition.through.from` | `From` |
| `definition.through.to` | `To` |
| `definition.via?` | `undefined` |

### Returns

`RelationshipDefinition`\<`From`\[`"target"`\], `To`\[`"target"`\], \{
  `cardinality`: `"many"`;
  `description?`: `string`;
  `name`: `Forward`;
\}, \{
  `cardinality`: `"many"`;
  `description?`: `string`;
  `name`: `Reverse`;
\}\> & \{
  `through`: \{
     `from`: `From`;
     `to`: `To`;
  \};
  `via?`: `undefined`;
\}
