# Function: defineSource()

```ts
function defineSource<S>(definition): Readonly<{
  fields: Readonly<{ readonly [K in string | number | symbol]: FieldReference<S[K]> }>;
  id: string;
  idField: Extract<keyof S, string>;
  schema: ZodObject<S>;
}>;
```

Defined in: [packages/relate/src/index.ts:82](https://github.com/relatehq/relate/blob/main/packages/relate/src/index.ts#L82)

Define the shape and identity of records supplied by a data source.

The returned `fields` expose typed references for mapping source fields onto
object properties. Bind the source to a connector when configuring the app.

## Type Parameters

| Type Parameter |
| ------ |
| `S` *extends* `Record`\<`string`, `ZodType`\<`unknown`, `unknown`, `$ZodTypeInternals`\<`unknown`, `unknown`\>\>\> |

## Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `definition` | \{ `id`: `string`; `idField`: `Extract`\<keyof `S`, `string`\>; `schema`: `ZodObject`\<`S`\>; \} | Stable source identity and its record schema. |
| `definition.id` | `string` | Stable identity of this source definition. |
| `definition.idField` | `Extract`\<keyof `S`, `string`\> | Schema field containing the provider record key. |
| `definition.schema` | `ZodObject`\<`S`\> | Schema describing the provider record. |

## Returns

`Readonly`\<\{
  `fields`: `Readonly`\<\{ readonly \[K in string \| number \| symbol\]: FieldReference\<S\[K\]\> \}\>;
  `id`: `string`;
  `idField`: `Extract`\<keyof `S`, `string`\>;
  `schema`: `ZodObject`\<`S`\>;
\}\>

An immutable source definition with typed field references.

## Example

```ts
import { defineSource } from 'relate';
import { z } from 'zod';

const customers = defineSource({
  id: 'crm-customers',
  idField: 'id',
  schema: z.object({ id: z.string(), name: z.string() }),
});

customers.fields.name; // Typed field reference for property mappings.
```
