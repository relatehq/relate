# Interface: QueryResult\<T\>

Defined in: [packages/protocol/src/index.ts:29](https://github.com/relatehq/relate/blob/main/packages/protocol/src/index.ts#L29)

Await one page, or iterate records across pages.

## Extends

- `PromiseLike`\<`Page`\<`T`\>\>.`AsyncIterable`\<`T`\>

## Type Parameters

| Type Parameter |
| ------ |
| `T` |

## Methods

### \[asyncIterator\]()

```ts
asyncIterator: AsyncIterator<T, any, any>;
```

Defined in: [node\_modules/.pnpm/typescript@6.0.3/node\_modules/typescript/lib/lib.es2018.asynciterable.d.ts:36](https://github.com/relatehq/relate/blob/main/node_modules/.pnpm/typescript@6.0.3/node_modules/typescript/lib/lib.es2018.asynciterable.d.ts#L36)

#### Returns

`AsyncIterator`\<`T`, `any`, `any`\>

#### Inherited from

```ts
AsyncIterable.[asyncIterator]
```

***

### then()

```ts
then<TResult1, TResult2>(onfulfilled?, onrejected?): PromiseLike<TResult1 | TResult2>;
```

Defined in: [node\_modules/.pnpm/typescript@6.0.3/node\_modules/typescript/lib/lib.es5.d.ts:1542](https://github.com/relatehq/relate/blob/main/node_modules/.pnpm/typescript@6.0.3/node_modules/typescript/lib/lib.es5.d.ts#L1542)

Attaches callbacks for the resolution and/or rejection of the Promise.

#### Type Parameters

| Type Parameter | Default type |
| ------ | ------ |
| `TResult1` | `Page`\<`T`\> |
| `TResult2` | `never` |

#### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `onfulfilled?` | ((`value`) => `TResult1` \| `PromiseLike`\<`TResult1`\>) \| `null` | The callback to execute when the Promise is resolved. |
| `onrejected?` | ((`reason`) => `TResult2` \| `PromiseLike`\<`TResult2`\>) \| `null` | The callback to execute when the Promise is rejected. |

#### Returns

`PromiseLike`\<`TResult1` \| `TResult2`\>

A Promise for the completion of which ever callback is executed.

#### Inherited from

```ts
PromiseLike.then
```
