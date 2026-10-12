# Type Alias: ObjectId\<DefinitionId\>

```ts
type ObjectId<DefinitionId> = string & {
  [objectIdBrand]: DefinitionId;
};
```

Defined in: [packages/relate/src/index.ts:17](https://github.com/relatehq/relate/blob/main/packages/relate/src/index.ts#L17)

A canonical record ID, scoped to its stable object definition ID.

## Type Declaration

### \[objectIdBrand\]

```ts
readonly [objectIdBrand]: DefinitionId;
```

## Type Parameters

| Type Parameter |
| ------ |
| `DefinitionId` *extends* `string` |
