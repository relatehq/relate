# Function: bind()

## Call Signature

```ts
function bind<D, C>(
   dataset,
   resource,
   options?
): DatasetBinding;
```

Defined in: [packages/relate/src/app.ts:55](https://github.com/relatehq/relate/blob/main/packages/relate/src/app.ts#L55)

Bind a dataset to a selected analytical resource; unspecified columns retain their names.

### Type Parameters

| Type Parameter | Default type |
| ------ | ------ |
| `D` *extends* `DatasetDefinition`\<`Readonly`\<`Record`\<`string`, `DatasetColumn`\<`ZodType`\<`unknown`, `unknown`, `$ZodTypeInternals`\<`unknown`, `unknown`\>\>\>\>\>\> | - |
| `C` *extends* `Readonly`\<`Record`\<`string`, `unknown`\>\> | \{ \} |

### Parameters

| Parameter | Type |
| ------ | ------ |
| `dataset` | `D` |
| `resource` | `AnalyticalResource` |
| `options?` | \{ `columns?`: `C` & \{ readonly \[K in string \| number \| symbol\]-?: string \} & `Record`\<`Exclude`\<keyof `C`, `Extract`\<keyof `NoInfer`\<`D`\>\[`"columns"`\], `string`\>\>, `never`\>; \} |
| `options.columns?` | `C` & \{ readonly \[K in string \| number \| symbol\]-?: string \} & `Record`\<`Exclude`\<keyof `C`, `Extract`\<keyof `NoInfer`\<`D`\>\[`"columns"`\], `string`\>\>, `never`\> |

### Returns

`DatasetBinding`

## Call Signature

```ts
function bind(source, resource): SourceAppBinding;
```

Defined in: [packages/relate/src/app.ts:70](https://github.com/relatehq/relate/blob/main/packages/relate/src/app.ts#L70)

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

Defined in: [packages/relate/src/app.ts:76](https://github.com/relatehq/relate/blob/main/packages/relate/src/app.ts#L76)

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

Defined in: [packages/relate/src/app.ts:85](https://github.com/relatehq/relate/blob/main/packages/relate/src/app.ts#L85)

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
