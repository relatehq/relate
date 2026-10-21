# Interface: ActionContext\<G, A\>

Defined in: [packages/relate/src/actions.ts:109](https://github.com/relatehq/relate/blob/main/packages/relate/src/actions.ts#L109)

## Type Parameters

| Type Parameter |
| ------ |
| `G` *extends* `GraphDefinition` |
| `A` *extends* `ActionDefinition` |

## Properties

| Property | Modifier | Type | Description | Defined in |
| ------ | ------ | ------ | ------ | ------ |
| <a id="actor"></a> `actor` | `readonly` | \{ `claims`: `Readonly`\<`Record`\<`string`, `string` \| `number` \| `boolean` \| `null`\>\>; `id`: `string`; `roles`: readonly `string`[]; \} | - | [packages/relate/src/actions.ts:120](https://github.com/relatehq/relate/blob/main/packages/relate/src/actions.ts#L120) |
| `actor.claims` | `readonly` | `Readonly`\<`Record`\<`string`, `string` \| `number` \| `boolean` \| `null`\>\> | - | [packages/relate/src/actions.ts:123](https://github.com/relatehq/relate/blob/main/packages/relate/src/actions.ts#L123) |
| `actor.id` | `readonly` | `string` | - | [packages/relate/src/actions.ts:121](https://github.com/relatehq/relate/blob/main/packages/relate/src/actions.ts#L121) |
| `actor.roles` | `readonly` | readonly `string`[] | - | [packages/relate/src/actions.ts:122](https://github.com/relatehq/relate/blob/main/packages/relate/src/actions.ts#L122) |
| <a id="fail"></a> `fail` | `readonly` | (...`args`) => `never` | Aborts this invocation and rolls back native writes, even if caught by the handler. | [packages/relate/src/actions.ts:127](https://github.com/relatehq/relate/blob/main/packages/relate/src/actions.ts#L127) |
| <a id="idempotencyid"></a> `idempotencyId` | `readonly` | `string` | The caller's idempotency key scoped to this graph instance, actor and action: stable across retries, rollback and restart, but distinct when another actor or action reuses the same key. Forward it to an external operation journal or provider idempotency API instead of the raw key. This identity alone does not make external writes atomic or deduplicate them. | [packages/relate/src/actions.ts:119](https://github.com/relatehq/relate/blob/main/packages/relate/src/actions.ts#L119) |
| <a id="input"></a> `input` | `readonly` | `PortableValue`\<`output`\<`A`\[`"input"`\]\>\> | - | [packages/relate/src/actions.ts:125](https://github.com/relatehq/relate/blob/main/packages/relate/src/actions.ts#L125) |
| <a id="objects"></a> `objects` | `readonly` | \{ readonly \[K in string \| number \| symbol\]: \{ get: any; query: any \} & (G\["objects"\]\[K\] extends A\["creates"\]\[number\] ? \{ create: any \} : \{\}) \} | - | [packages/relate/src/actions.ts:136](https://github.com/relatehq/relate/blob/main/packages/relate/src/actions.ts#L136) |
