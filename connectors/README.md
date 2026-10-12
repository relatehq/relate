# Provider connectors

Provider integrations live here as `@relate/connector-<provider>` packages. They
implement resource adapter contracts from `relate/connectors`, separately from
Relate storage adapters such as `@relate/postgres`.

- [SQLite](sqlite): read records from an existing SQLite database. See the
  [customer accounts example](../examples/02-customer-accounts).
- [Stripe](stripe): read selected billing resources with verified account and
  test/live identity. The README includes a complete binding example.
- [Salesforce](salesforce): read Accounts with verified org identity. See the
  [Salesforce example](../examples/05-salesforce).

All connectors currently read known IDs; enumeration, sync, webhooks, and
provider writes are not implemented. See the public
[Connecting Sources guide](../apps/docs/content/authoring/connections.md) for
bindings, identity, custom connectors, and failure semantics.

## Follow-up work

Stripe has deterministic HTTP and runtime integration coverage, but no claimed
live-account validation. A hosted sandbox suite and a runnable cross-provider
SQLite/Stripe example remain follow-up work. These are validation and learning
gaps, not missing connector implementations.
