# Type Alias: ReadOptions\<K, E\>

```ts
type ReadOptions<K, E> = ReadControlOptions<K, E> & Omit<ObjectReadRequest, keyof ReadControls>;
```

Defined in: [packages/relate/src/operations.ts:44](https://github.com/relatehq/relate/blob/main/packages/relate/src/operations.ts#L44)

Object reads may extend common controls without widening traversal.

## Type Parameters

| Type Parameter | Default type |
| ------ | ------ |
| `K` *extends* `string` | - |
| `E` *extends* `EvidenceMode` | `EvidenceMode` |
