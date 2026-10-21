# Function: bind()

## Call Signature

```ts
function bind(source, resource): Binding;
```

Defined in: [packages/relate/src/app.ts:24](https://github.com/relatehq/relate/blob/main/packages/relate/src/app.ts#L24)

Custom adapters may supply the explicit resource identity and keyed reader.

### Parameters

| Parameter | Type |
| ------ | ------ |
| `source` | `SourceDefinition` |
| `resource` | \| `Omit`\<`BindingOptions` & \{ `connector`: `SourceConnector`; `providerAccountId`: `string`; \}, `"authorization"`\> & \{ `authorization?`: `"shared-service"`; \} \| `Omit`\<`BindingOptions` & \{ `connector`: `ApplicationSourceConnector`; `providerAccountId?`: `undefined`; \}, `"authorization"`\> & \{ `authorization?`: `"shared-service"`; \} |

### Returns

`Binding`

## Call Signature

```ts
function bind(
   source,
   resource,
   options?
): Binding;
```

Defined in: [packages/relate/src/app.ts:30](https://github.com/relatehq/relate/blob/main/packages/relate/src/app.ts#L30)

Bind a source contract to a selected resource without opening it.

### Parameters

| Parameter | Type |
| ------ | ------ |
| `source` | `SourceDefinition` |
| `resource` | `SourceResource`\<`ApplicationSourceConnector`\> |
| `options?` | \{ `authorization?`: `"shared-service"`; `providerAccountId?`: `undefined`; \} |
| `options.authorization?` | `"shared-service"` |
| `options.providerAccountId?` | `undefined` |

### Returns

`Binding`

## Call Signature

```ts
function bind(
   source,
   resource,
   options
): Binding;
```

Defined in: [packages/relate/src/app.ts:39](https://github.com/relatehq/relate/blob/main/packages/relate/src/app.ts#L39)

Custom adapters may supply the explicit resource identity and keyed reader.

### Parameters

| Parameter | Type |
| ------ | ------ |
| `source` | `SourceDefinition` |
| `resource` | `SourceResource`\<`SourceConnector`\> |
| `options` | \{ `authorization?`: `"shared-service"`; `providerAccountId`: `string`; \} |
| `options.authorization?` | `"shared-service"` |
| `options.providerAccountId` | `string` |

### Returns

`Binding`
