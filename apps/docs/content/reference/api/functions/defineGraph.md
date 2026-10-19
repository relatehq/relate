# Function: defineGraph()

```ts
function defineGraph<G>(graph): G;
```

Defined in: [packages/relate/src/index.ts:535](https://github.com/relatehq/relate/blob/main/packages/relate/src/index.ts#L535)

## Type Parameters

| Type Parameter |
| ------ |
| `G` *extends* `GraphDefinition` |

## Parameters

| Parameter | Type |
| ------ | ------ |
| `graph` | `G` & \{ `policies`: `Policies`\<`NoInfer`\<`G`\[`"objects"`\]\>, `NoInfer`\<`G`\[`"access"`\]\>\> & `ExactPolicyInput`\<`G`\[`"policies"`\], `Policies`\<`NoInfer`\<`G`\[`"objects"`\]\>, `NoInfer`\<`G`\[`"access"`\]\>\>\>; `principals?`: `Readonly`\<`Record`\<`string`, `PrincipalDefinition`\<`NoInfer`\<`G`\[`"access"`\]\>\>\>\>; \} |

## Returns

`G`
