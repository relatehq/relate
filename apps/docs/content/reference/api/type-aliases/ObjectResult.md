# Type Alias: ObjectResult\<O, K, E\>

```ts
type ObjectResult<O, K, E> =
  | {
  status: "not-found";
}
  | {
  data: ObjectData<O, K>;
  id: ObjectId<O["id"]>;
  meta: DeclaredComputedMeta<TypedMeta<Extract<ReadMeta, {
     evidence: E;
  }>, K>, Extract<K, ComputedPropertyNames<O>>>;
  status: "ok";
};
```

Defined in: [packages/relate/src/operations.ts:69](https://github.com/relatehq/relate/blob/main/packages/relate/src/operations.ts#L69)

Read methods guarantee full only for a required full evidence option.

## Type Parameters

| Type Parameter | Default type |
| ------ | ------ |
| `O` *extends* `ObjectDefinition` | - |
| `K` *extends* `PropertyNames`\<`O`\> | `PropertyNames`\<`O`\> |
| `E` *extends* `EvidenceMode` | `EvidenceMode` |
