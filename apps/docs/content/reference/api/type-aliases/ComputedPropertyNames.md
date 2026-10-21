# Type Alias: ComputedPropertyNames\<O\>

```ts
type ComputedPropertyNames<O> = { [K in keyof O["properties"]]: O["properties"][K]["origin"]["kind"] extends "computed" ? K : never }[keyof O["properties"]] & string;
```

Defined in: [packages/relate/src/computed.ts:52](https://github.com/relatehq/relate/blob/main/packages/relate/src/computed.ts#L52)

## Type Parameters

| Type Parameter |
| ------ |
| `O` *extends* `ObjectDefinition` |
