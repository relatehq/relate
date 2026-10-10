# Type Alias: QueryOptions\<O, K, E\>

```ts
type QueryOptions<O, K, E> = PageOptions<K, E> & {
  where?: { readonly [N in PropertyNames<O>]?: PropertyFilter<O["properties"][N], Exclude<PropertyValue<O, N>, undefined>> };
};
```

Defined in: [packages/relate/src/operations.ts:117](https://github.com/relatehq/relate/blob/main/packages/relate/src/operations.ts#L117)

Filter and page through objects already adopted into the graph, or through
the records a to-many traversal reaches.

Properties and operators combine with AND. Use scalar equality, eq/in, or
gt/gte/lt/lte on numbers and timestamps. Reference properties take
Relate object IDs. Queries do not discover provider-wide records. A
traversal's filters address the related object's properties and apply in
addition to the relationship.

## Type Declaration

### where?

```ts
readonly optional where?: { readonly [N in PropertyNames<O>]?: PropertyFilter<O["properties"][N], Exclude<PropertyValue<O, N>, undefined>> };
```

Typed scalar predicates keyed by object property name.

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
const open = await objects.Customer.traverse.invoices(customerId, {
  where: { status: 'open', totalMinor: { gte: 10_000 } },
});
```
