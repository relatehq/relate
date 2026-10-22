# Type Alias: ActionRequest\<A\>

```ts
type ActionRequest<A> = {
  idempotencyKey: string;
  input: PortableValue<z.input<A["input"]>>;
};
```

Defined in: [packages/relate/src/actions.ts:221](https://github.com/relatehq/relate/blob/main/packages/relate/src/actions.ts#L221)

## Type Parameters

| Type Parameter |
| ------ |
| `A` *extends* `ActionDefinition` |

## Properties

| Property | Modifier | Type | Defined in |
| ------ | ------ | ------ | ------ |
| <a id="idempotencykey"></a> `idempotencyKey` | `readonly` | `string` | [packages/relate/src/actions.ts:223](https://github.com/relatehq/relate/blob/main/packages/relate/src/actions.ts#L223) |
| <a id="input"></a> `input` | `readonly` | `PortableValue`\<`z.input`\<`A`\[`"input"`\]\>\> | [packages/relate/src/actions.ts:222](https://github.com/relatehq/relate/blob/main/packages/relate/src/actions.ts#L222) |
