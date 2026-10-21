# Type Alias: QueryOptions\<O, K, E\>

```ts
type QueryOptions<O, K, E> = CollectionReadOptions<O, K, E> & ReadOptions<K, E> & {
  orderBy?: readonly {
     direction: "asc" | "desc";
     field: ComputedPropertyNames<O>;
  }[];
};
```

Defined in: [packages/relate/src/operations.ts:151](https://github.com/relatehq/relate/blob/main/packages/relate/src/operations.ts#L151)

Object queries have an independent extension point from related collections.

## Type Declaration

### orderBy?

```ts
readonly optional orderBy?: readonly {
  direction: "asc" | "desc";
  field: ComputedPropertyNames<O>;
}[];
```

## Type Parameters

| Type Parameter | Default type |
| ------ | ------ |
| `O` *extends* `ObjectDefinition` | - |
| `K` *extends* `PropertyNames`\<`O`\> | `PropertyNames`\<`O`\> |
| `E` *extends* `EvidenceMode` | `EvidenceMode` |
