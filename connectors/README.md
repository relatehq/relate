# Provider connectors

Each implemented provider integration will be a workspace package here, named
`@relate/connector-<provider>`. No provider implementation is scaffolded yet.

Connectors implement resource adapter contracts from `relate/connectors`. They
are separate from Relate storage adapters such as `@relate/postgres`.
