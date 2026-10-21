# Type Alias: ObjectRecord\<O, K, E\>

```ts
type ObjectRecord<O, K, E> = Omit<Extract<ObjectResult<O, K, E>, {
  status: "ok";
}>, "status">;
```

Defined in: [packages/relate/src/operations.ts:151](https://github.com/relatehq/relate/blob/main/packages/relate/src/operations.ts#L151)

## Type Parameters

| Type Parameter | Default type |
| ------ | ------ |
| `O` *extends* `ObjectDefinition` | - |
| `K` *extends* `PropertyNames`\<`O`\> | `PropertyNames`\<`O`\> |
| `E` *extends* `EvidenceMode` | `EvidenceMode` |
