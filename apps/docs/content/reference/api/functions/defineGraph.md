# Function: defineGraph()

```ts
function defineGraph<G>(graph): G;
```

Defined in: [packages/relate/src/index.ts:559](https://github.com/relatehq/relate/blob/main/packages/relate/src/index.ts#L559)

## Type Parameters

| Type Parameter |
| ------ |
| `G` *extends* `GraphDefinition` |

## Parameters

| Parameter | Type |
| ------ | ------ |
| `graph` | `G` & \{ `policies`: \{ readonly \[K in string \| number \| symbol\]: Policy\<NoInfer\<G\["access"\]\>\["roles"\]\[number\], NoInfer\<G\["access"\]\>\["fieldGroups"\]\[number\], PolicyWhere\<NoInfer\<G\["objects"\]\>, NoInfer\<G\["objects"\]\>\[K\]\>, Extract\<keyof NonNullable\<(...)\[(...)\]\["datasets"\]\>, string\>\> & \{ create?: NoInfer\<(...)\>\[K\]\["membership"\] extends \{ kind: "native" \} ? ("deny" \| ObjectRule\<NoInfer\<G\["access"\]\>\["roles"\]\[number\], PolicyWhere\<NoInfer\<G\["objects"\]\>, NoInfer\<G\["objects"\]\>\[K\]\>\>) : never \} & (keyof NonNullable\<NoInfer\<(...)\>\[K\]\["datasets"\]\> extends never ? \{\} : \{ datasets: \{ readonly \[A in string \| number \| symbol\]: \{ gate: RoleGate\<(...)\[(...)\]\> \} \} \}) \} & \{ readonly \[K in string \| number \| symbol\]: DatasetPolicy\<NoInfer\<G\["access"\]\>\["roles"\]\[number\], NoInfer\<G\["access"\]\>\["fieldGroups"\]\[number\]\> \} & `ExactPolicyInput`\<`G`\[`"policies"`\], `Policies`\<`NoInfer`\<`G`\[`"objects"`\]\>, `NoInfer`\<`G`\[`"access"`\]\>, `G` *extends* \{ `datasets`: `D`; \} ? `NoInfer`\<`D`\> : \{ \}\>\>; `principals?`: `Readonly`\<`Record`\<`string`, `PrincipalDefinition`\<`NoInfer`\<`G`\[`"access"`\]\>\>\>\>; \} |

## Returns

`G`
