# @relate/postgres

Durable Relate storage for the first embedded read. Private and unpublished.

`createPostgresStore({ connectionString })` provides `migrate()`, the runtime's
observation storage contract, and `close()`. Hosts explicitly migrate before
use. Supply an existing database; the database name is part of the connection
URL. Relate does not create databases or start/stop the server. The connecting
role needs permission to create and migrate the `relate` schema.

The adapter owns the `relate` schema; it never modifies provider tables.

Checksummed migrations establish installed graph revisions, durable canonical
identities/source aliases, latest whole source records and mapped values, and
applied-value history. Scope includes graph, object type, source, connection and
shared service-account partition. An installed graph rejects a different model
revision pending explicit migration support.

A database sequence assigns comparable fetch-start tokens before provider I/O.
Per-alias transaction locks serialize acceptance across processes. Membership,
raw retention, projection and value history commit atomically; unchanged values
refresh observation evidence without creating value-change events. Provider
versions take precedence over fetch-start order. Failed commits do not advance
accepted state; lost commit acknowledgements remain unconfirmed until readback.

History currently records source adoption/refresh changes for this slice.
History query APIs, cleanup/retention scheduling, erasure, model migrations, and
native business writes are not implemented. Do not treat this initial schema as
a production retention lifecycle.
