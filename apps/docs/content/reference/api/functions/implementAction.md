# Function: implementAction()

```ts
function implementAction<G, A>(
   graph,
   action,
   execute
): ActionImplementation<G, A>;
```

Defined in: [packages/relate/src/actions.ts:191](https://github.com/relatehq/relate/blob/main/packages/relate/src/actions.ts#L191)

## Type Parameters

| Type Parameter |
| ------ |
| `G` *extends* `GraphDefinition` & \{ `actions`: `Readonly`\<`Record`\<`string`, `ActionDefinition`\>\>; \} |
| `A` *extends* `ActionDefinition`\<`ZodType`\<`unknown`, `unknown`, `$ZodTypeInternals`\<`unknown`, `unknown`\>\>, `ZodType`\<`unknown`, `unknown`, `$ZodTypeInternals`\<`unknown`, `unknown`\>\>, readonly `NativeObject`[], `Readonly`\<`Record`\<`string`, `ZodType`\<`unknown`, `unknown`, `$ZodTypeInternals`\<`unknown`, `unknown`\>\>\>\>\> |

## Parameters

| Parameter | Type |
| ------ | ------ |
| `graph` | `G` |
| `action` | `A` |
| `execute` | (`context`) => `Promise`\<`input`\<`A`\[`"output"`\]\>\> |

## Returns

`ActionImplementation`\<`G`, `A`\>
