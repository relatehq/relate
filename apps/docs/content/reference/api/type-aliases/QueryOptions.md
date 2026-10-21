# Type Alias: QueryOptions\<O, K, E\>

```ts
type QueryOptions<O, K, E> = CollectionReadOptions<O, K, E> & ReadOptions<K, E>;
```

Defined in: [packages/relate/src/operations.ts:148](https://github.com/relatehq/relate/blob/main/packages/relate/src/operations.ts#L148)

Object queries have an independent extension point from related collections.

## Type Parameters

| Type Parameter | Default type |
| ------ | ------ |
| `O` *extends* `ObjectDefinition` | - |
| `K` *extends* `PropertyNames`\<`O`\> | `PropertyNames`\<`O`\> |
| `E` *extends* `EvidenceMode` | `EvidenceMode` |
