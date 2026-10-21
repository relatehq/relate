# Function: bind()

## Call Signature

```ts
function bind<D>(
   dataset,
   resource,
   options?
): DatasetBinding;
```

Defined in: [packages/relate/src/app.ts:47](https://github.com/relatehq/relate/blob/main/packages/relate/src/app.ts#L47)

Bind a dataset to a selected analytical resource; unspecified columns retain their names.

### Type Parameters

| Type Parameter |
| ------ |
| `D` *extends* `DatasetDefinition`\<`Readonly`\<`Record`\<`string`, `DatasetColumn`\<`ZodType`\<`unknown`, `unknown`, `$ZodTypeInternals`\<`unknown`, `unknown`\>\>\>\>\>\> |

### Parameters

| Parameter | Type |
| ------ | ------ |
| `dataset` | `D` |
| `resource` | `AnalyticalResource` |
| `options?` | \{ `columns?`: `Partial`\<`Record`\<`Extract`\<keyof `NoInfer`\<`D`\>\[`"columns"`\], `string`\>, `string`\>\>; \} |
| `options.columns?` | `Partial`\<`Record`\<`Extract`\<keyof `NoInfer`\<`D`\>\[`"columns"`\], `string`\>, `string`\>\> |

### Returns

`DatasetBinding`

## Call Signature

```ts
function bind(source, resource): SourceAppBinding;
```

Defined in: [packages/relate/src/app.ts:58](https://github.com/relatehq/relate/blob/main/packages/relate/src/app.ts#L58)

Custom adapters may supply the explicit resource identity and keyed reader.

### Parameters

| Parameter | Type |
| ------ | ------ |
| `source` | `SourceDefinition` |
| `resource` | \| `Omit`\<`BindingOptions` & \{ `connector`: `SourceConnector`; `providerAccountId`: `string`; \}, `"authorization"`\> & \{ `authorization?`: `"shared-service"`; `connection?`: `ResourceConnection`; \} \| `Omit`\<`BindingOptions` & \{ `connector`: `ApplicationSourceConnector`; `providerAccountId?`: `undefined`; \}, `"authorization"`\> & \{ `authorization?`: `"shared-service"`; `connection?`: `ResourceConnection`; \} |

### Returns

`SourceAppBinding`

## Call Signature

```ts
function bind(
   source,
   resource,
   options?
): SourceAppBinding;
```

Defined in: [packages/relate/src/app.ts:64](https://github.com/relatehq/relate/blob/main/packages/relate/src/app.ts#L64)

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

`SourceAppBinding`

## Call Signature

```ts
function bind(
   source,
   resource,
   options
): SourceAppBinding;
```

Defined in: [packages/relate/src/app.ts:73](https://github.com/relatehq/relate/blob/main/packages/relate/src/app.ts#L73)

Bind a dataset to a selected analytical resource; unspecified columns retain their names.

### Parameters

| Parameter | Type |
| ------ | ------ |
| `source` | `SourceDefinition` |
| `resource` | `SourceResource`\<`SourceConnector`\> |
| `options` | \{ `authorization?`: `"shared-service"`; `providerAccountId`: `string`; \} |
| `options.authorization?` | `"shared-service"` |
| `options.providerAccountId` | `string` |

### Returns

`SourceAppBinding`
