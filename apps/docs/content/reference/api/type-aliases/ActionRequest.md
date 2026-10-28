# Type Alias: ActionRequest\<A\>

```ts
type ActionRequest<A> = {
  idempotencyKey: string;
  input: PortableValue<z.input<A["input"]>>;
};
```

Defined in: [packages/relate/src/actions.ts:243](https://github.com/relatehq/relate/blob/main/packages/relate/src/actions.ts#L243)

## Type Parameters

| Type Parameter |
| ------ |
| `A` *extends* `ActionDefinition` |

## Properties

| Property | Modifier | Type | Defined in |
| ------ | ------ | ------ | ------ |
| <a id="idempotencykey"></a> `idempotencyKey` | `readonly` | `string` | [packages/relate/src/actions.ts:245](https://github.com/relatehq/relate/blob/main/packages/relate/src/actions.ts#L245) |
| <a id="input"></a> `input` | `readonly` | `PortableValue`\<`z.input`\<`A`\[`"input"`\]\>\> | [packages/relate/src/actions.ts:244](https://github.com/relatehq/relate/blob/main/packages/relate/src/actions.ts#L244) |
