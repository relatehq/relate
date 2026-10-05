# Hello world

The smallest working Relate example: declare a source and object, bind a tiny
in-process source, adopt a record, and perform one authorized read.

```sh
pnpm install
pnpm example:hello-world
```

Everything is in [src/index.ts](src/index.ts). There is no database, HTTP
server, credential or migration setup. Omitting `store` creates an isolated
memory store. The result contains Ada's name, a generated object ID, and read
evidence with `retention: 'confirmed'` and `retentionDurability: 'volatile'`.
State disappears when the store instance is lost; creating another default
runtime starts empty.

Keep this example minimal as Relate evolves. Refresh, restart recovery and
persistent storage belong in
[Postgres persistence](../postgres-persistence/README.md). For custom
persistence, see the [store contract](../../packages/runtime/STORE_CONTRACT.md).
