# Type Alias: PageOptions\<K, E\>

```ts
type PageOptions<K, E> = ReadControlOptions<K, E> & {
  cursor?: string;
  limit?: number;
};
```

Defined in: [packages/relate/src/operations.ts:85](https://github.com/relatehq/relate/blob/main/packages/relate/src/operations.ts#L85)

## Type Declaration

### cursor?

```ts
readonly optional cursor?: string;
```

### limit?

```ts
readonly optional limit?: number;
```

## Type Parameters

| Type Parameter | Default type |
| ------ | ------ |
| `K` *extends* `string` | - |
| `E` *extends* `EvidenceMode` | `EvidenceMode` |
