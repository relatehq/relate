# Function: bind()

```ts
function bind(source, binding): Binding;
```

Defined in: [packages/relate/src/app.ts:19](https://github.com/relatehq/relate/blob/main/packages/relate/src/app.ts#L19)

This slice supports shared service credentials only. Credentials stay in the connector.

## Parameters

| Parameter | Type |
| ------ | ------ |
| `source` | `SourceDefinition` |
| `binding` | \| `Omit`\<`BindingOptions` & \{ `connector`: `SourceConnector`; `providerAccountId`: `string`; \}, `"authorization"`\> & \{ `authorization?`: `"shared-service"`; \} \| `Omit`\<`BindingOptions` & \{ `connector`: `ApplicationSourceConnector`; `providerAccountId?`: `undefined`; \}, `"authorization"`\> & \{ `authorization?`: `"shared-service"`; \} |

## Returns

`Binding`
