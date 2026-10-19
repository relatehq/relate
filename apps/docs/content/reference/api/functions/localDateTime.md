# Function: localDateTime()

```ts
function localDateTime(options): LocalDateTimeSchema;
```

Defined in: [packages/relate/src/local-datetime.ts:16](https://github.com/relatehq/relate/blob/main/packages/relate/src/local-datetime.ts#L16)

Explicit wall-clock schema. The application owns its common clock domain.

## Parameters

| Parameter | Type |
| ------ | ------ |
| `options` | \{ `precision`: `LocalDateTimePrecision`; \} |
| `options.precision` | `LocalDateTimePrecision` |

## Returns

`LocalDateTimeSchema`
