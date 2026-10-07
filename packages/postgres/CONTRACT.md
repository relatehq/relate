# @relate/postgres contract

Detailed behavior of the current slice. For an overview of the package, see
[README.md](./README.md).

Durable Relate storage for embedded reads and native account-review actions.
Private and unpublished.

`createPostgresStore({ connectionString })` provides `migrate()`, the runtime's
observation storage contract, the optional native transaction capability, and
`close()`. Hosts explicitly migrate before use. Supply an existing database; the
database name is part of the connection URL. Relate does not create databases or
start/stop the server. The connecting role needs permission to create and
migrate the `relate` schema.

The adapter owns the `relate` schema; it never modifies provider tables.

Checksummed migrations establish installed graph revisions, durable canonical
identities/source aliases, latest whole source records and mapped values, and
applied-value history. Scope includes graph, object type, source, connection,
provider account and shared service-account partition. An installed graph
rejects a different model revision pending explicit migration support.

A database sequence assigns comparable fetch-start tokens before provider I/O.
Per-alias transaction locks serialize acceptance across processes. Membership,
raw retention, projection and value history commit atomically; unchanged values
refresh observation evidence without creating value-change events. Provider
versions take precedence over fetch-start order. Failed commits do not advance
accepted state; lost commit acknowledgements remain unconfirmed until readback.

History currently records source adoption/refresh changes for this slice.
History query APIs, cleanup/retention scheduling, erasure and model migrations
are not implemented. Do not treat this initial schema as a production retention
lifecycle.

## Native transactions

The additive second migration creates `native_objects` and `native_invocations`.
Native values use stable property definition IDs. A native transaction
serializes writes per graph, reserves the graph/action/key, and commits native
inserts with successful receipt/input evidence. Errors roll back the entire
transaction; a lost COMMIT acknowledgement throws `NativeCommitUncertain`
instead of claiming failure. This is surfaced as a sanitized uncertain action
rejection; consumer recovery follows in the next slice.

Native transactions use a separate five-connection pool from source
observations, so queued native writers cannot starve their own authorization
reads. Native connection acquisition, lock waits and statements each have a
30-second timeout. The native idle-in-transaction timeout is 60 seconds as a
backstop for abandoned sessions. The runtime separately bounds the complete
native callback to at most 60 seconds, including handler and source awaits;
callback expiry rolls back and releases the connection. A session failure also
interrupts a suspended callback immediately and removes the broken pool client.
Source-observation pool limits remain 2 seconds for connections/locks, 3 seconds
for statements and 5 seconds for idle transactions. `close()` closes both pools.

Known connection failures and lock/statement timeouts before COMMIT surface as
`StorageUnavailable`, which actions map to sanitized
`ActionError('unavailable')`. A known transaction rejection or COMMIT response
of ROLLBACK also means confirmed failure; an ambiguous COMMIT connection loss
remains `uncertain`. Native writes still serialize per graph: long handlers can
exhaust a queued caller's 30-second lock budget. An already-running SQL
statement may delay rollback until it finishes or hits its statement timeout.
Shorter lock ownership remains future work.

Native transactions do not enlist provider I/O or source observation acceptance.
There is no distributed snapshot guarantee.

See [native account reviews](../node/NATIVE_ACTIONS.md) and
[the adapter contract](../runtime/STORE_CONTRACT.md#native-write-capability).
