# Type Alias: QueryOptions\<O, K, E\>

```ts
type QueryOptions<O, K, E> = PageOptions<K, E> & {
  where?: { readonly [N in PropertyNames<O>]?: Exclude<PropertyValue<O, N>, undefined> };
};
```

Defined in: packages/relate/src/operations.ts:84

Filter and page through objects already adopted into the graph.

Filters combine with AND and use exact equality. Reference properties take
Relate object IDs. Queries do not discover provider-wide records.

## Type Declaration

### where?

```ts
readonly optional where?: { readonly [N in PropertyNames<O>]?: Exclude<PropertyValue<O, N>, undefined> };
```

Exact-match filters keyed by object property name.

## Type Parameters

| Type Parameter | Default type |
| ------ | ------ |
| `O` *extends* `ObjectDefinition` | - |
| `K` *extends* `PropertyNames`\<`O`\> | `PropertyNames`\<`O`\> |
| `E` *extends* `EvidenceMode` | `EvidenceMode` |

## Example

```ts
const customers = await objects.Customer.query({
  select: ['name', 'status'],
  where: { status: 'active' },
  limit: 20,
});
```
