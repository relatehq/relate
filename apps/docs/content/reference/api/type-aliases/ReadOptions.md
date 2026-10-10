# Type Alias: ReadOptions\<K, E\>

```ts
type ReadOptions<K, E> = Omit<ReadRequest, "select" | "evidence"> & {
  evidence?: E;
  select?: readonly K[];
};
```

Defined in: [packages/relate/src/operations.ts:31](https://github.com/relatehq/relate/blob/main/packages/relate/src/operations.ts#L31)

Select properties and control evidence detail for an object read.

Evidence is compact by default. Request `full` when you need provenance for
every selected field. Selection never bypasses authorization.

## Type Declaration

### evidence?

```ts
readonly optional evidence?: E;
```

Evidence presentation; defaults to compact.

### select?

```ts
readonly optional select?: readonly K[];
```

Property names to read from the object.

## Type Parameters

| Type Parameter | Default type |
| ------ | ------ |
| `K` *extends* `string` | - |
| `E` *extends* `EvidenceMode` | `EvidenceMode` |

## Example

```ts
const customer = await objects.Customer.get(customerId, {
  select: ['name'],
  evidence: 'full',
});
```
