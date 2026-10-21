# Function: referenceInput()

```ts
function referenceInput<O>(object, options?): ZodType<ObjectId<O["id"]>, ObjectId<O["id"]>>;
```

Defined in: [packages/relate/src/index.ts:35](https://github.com/relatehq/relate/blob/main/packages/relate/src/index.ts#L35)

A string on the wire and in memory; no wrapper, lookup, or access grant.
Typed calls require an already branded ID. Use `.parse(unknown)` at external
boundaries to validate a nonblank string and declare its expected object type.
Parsing cannot establish existence, actual object type, or authorization.

## Type Parameters

| Type Parameter |
| ------ |
| `O` *extends* `Pick`\<`ObjectDefinition`, `"id"` \| `"properties"`\> |

## Parameters

| Parameter | Type |
| ------ | ------ |
| `object` | `O` |
| `options?` | \{ `description?`: `string`; \} |
| `options.description?` | `string` |

## Returns

`ZodType`\<[`ObjectId`](../type-aliases/ObjectId.md)\<`O`\[`"id"`\]\>, [`ObjectId`](../type-aliases/ObjectId.md)\<`O`\[`"id"`\]\>\>
