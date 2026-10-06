# Hello world

The smallest working Relate example: declare a source and object, bind a tiny
in-process source, adopt a record, and perform one typed, authorized read.

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

`createRuntime` and `connect` come from `@relate/node`. Graph objects are named
(`objects: { Person }`), and callers use
`relate.as(principal).objects.Person.get(id, { select: ['name'] })`. The
result's canonical ID is separate from its selected data. `assertFields` checks
availability before using the typed name. The host authenticates the principal;
adoption is available only through `relate.host`.

The acceptance suite checks this same public API for authorization, partial
fields, fallback and registration. Packaging verification compiles and runs this
exact example with installed tarballs under plain Node ESM.

```sh
pnpm test:unit
pnpm test:packaging
```

Keep this example minimal as Relate evolves. Refresh, restart recovery and
persistent storage belong in
[Postgres persistence](../postgres-persistence/README.md). For custom
persistence, see the [store contract](../../packages/runtime/STORE_CONTRACT.md).
