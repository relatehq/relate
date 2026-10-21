# Type Alias: ObjectResult\<O, K, E\>

```ts
type ObjectResult<O, K, E> =
  | {
  status: "not-found";
}
  | {
  data: ObjectData<O, K>;
  id: ObjectId<O["id"]>;
  meta: TypedMeta<Extract<ReadMeta, {
     evidence: E;
  }>, K>;
  status: "ok";
};
```

Defined in: [packages/relate/src/operations.ts:51](https://github.com/relatehq/relate/blob/main/packages/relate/src/operations.ts#L51)

Read methods guarantee full only for a required full evidence option.

## Type Parameters

| Type Parameter | Default type |
| ------ | ------ |
| `O` *extends* `ObjectDefinition` | - |
| `K` *extends* `PropertyNames`\<`O`\> | `PropertyNames`\<`O`\> |
| `E` *extends* `EvidenceMode` | `EvidenceMode` |
