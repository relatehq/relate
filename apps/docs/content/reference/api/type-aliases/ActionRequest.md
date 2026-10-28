# Type Alias: ActionRequest\<A\>

```ts
type ActionRequest<A> = {
  idempotencyKey: string;
  input: PortableValue<z.input<A["input"]>>;
};
```

Defined in: [packages/relate/src/actions.ts:250](https://github.com/relatehq/relate/blob/main/packages/relate/src/actions.ts#L250)

## Type Parameters

| Type Parameter |
| ------ |
| `A` *extends* `ActionDefinition` |

## Properties

| Property | Modifier | Type | Defined in |
| ------ | ------ | ------ | ------ |
| <a id="idempotencykey"></a> `idempotencyKey` | `readonly` | `string` | [packages/relate/src/actions.ts:252](https://github.com/relatehq/relate/blob/main/packages/relate/src/actions.ts#L252) |
| <a id="input"></a> `input` | `readonly` | `PortableValue`\<`z.input`\<`A`\[`"input"`\]\>\> | [packages/relate/src/actions.ts:251](https://github.com/relatehq/relate/blob/main/packages/relate/src/actions.ts#L251) |
