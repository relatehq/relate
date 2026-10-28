# Type Alias: Receipt\<A\>

```ts
type Receipt<A> =
  | SucceededReceipt<PortableValue<z.output<A["output"]>>>
  | { [Code in keyof A["errors"] & string]: FailedReceipt<Code, PortableValue<z.output<A["errors"][Code]>>> }[keyof A["errors"] & string];
```

Defined in: [packages/relate/src/actions.ts:241](https://github.com/relatehq/relate/blob/main/packages/relate/src/actions.ts#L241)

Actions without declared errors retain a success-only result type.

## Type Parameters

| Type Parameter |
| ------ |
| `A` *extends* `ActionDefinition` |
