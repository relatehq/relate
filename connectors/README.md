# Provider connectors

Provider integrations live here as `@relate/connector-<provider>` packages. They
implement resource adapter contracts from `relate/connectors`, separately from
Relate storage adapters such as `@relate/postgres`.

- [SQLite](sqlite): read records from an existing SQLite database. See the
  [customer accounts example](../examples/customer-accounts).
