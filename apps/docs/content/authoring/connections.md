# Connecting Sources

A source definition describes records. A connector reads them from an external
system, and `connect(source, binding)` attaches that access to your graph.
Connectors do not own your business objects, property mappings, or policies.

## Choose a Connector

| Connector                                                 | Resource selection                            | Identity                                                     | Working example                                                          |
| --------------------------------------------------------- | --------------------------------------------- | ------------------------------------------------------------ | ------------------------------------------------------------------------ |
| [SQLite](../../../../connectors/sqlite/README.md)         | `database.table(name, { idColumn, columns })` | Application-owned by default; optional database verification | [Customer accounts](../../../../examples/02-customer-accounts/README.md) |
| [Stripe](../../../../connectors/stripe/README.md)         | `stripeConnection.resource(name, { fields })` | Verified account plus test/live namespace                    | Binding example in the connector README                                  |
| [Salesforce](../../../../connectors/salesforce/README.md) | `crm.resource('Account', { fields })`         | Verified Salesforce org                                      | [Salesforce customers](../../../../examples/05-salesforce/README.md)     |

All three read known record IDs. Enumeration, synchronization, webhooks, and
provider writes are not implemented. SQLite here is a source; the
[Postgres store](../deployment/postgres.md) separately persists Relate's state.
Packages are currently used from a repository checkout, not installed from npm.

## Systems, Resources, Sources, and Bindings

A **system connection** owns provider configuration and credentials. A selected
**resource**, such as a table or API object type, supplies a record reader. Your
**source definition** declares the schema that reader must return. A **binding**
connects that source to the reader and supplies its stable identity.

```ts
import { sqlite } from '@relate/connector-sqlite';
import { connect, defineApp } from 'relate';
import { graph, customers } from './model.js';

// This example assumes graph's only source is customers.
export default defineApp({
  graph,
  setup({ onDispose }) {
    const database = sqlite({ path: './crm.sqlite' });
    onDispose(() => database.close());

    return {
      connections: [
        connect(customers, {
          connectionId: 'crm',
          connector: database.table('customers', {
            idColumn: 'id',
            columns: ['name'],
          }),
        }),
      ],
    };
  },
});
```

Here `customers` is a `defineSource` with `idField: 'id'` and a schema
containing string `id` and `name` fields. A system can supply several resources.
Bind each modeled source explicitly, and register cleanup once for the shared
system. See [Application Setup](../runtime/application.md) for startup and
shutdown.

## Connection Identity

With **provider verification**, pass the expected `providerAccountId`. The
connector authenticates and supplies evidence of its actual account; a
configured label alone is not verification. Stripe includes test/live mode in
the account identity because it changes the record namespace.

With **application-owned identity**, omit `providerAccountId` and use a
connector with `identity: 'application'`. Keep `connectionId` stable for the
same logical source; choose a new ID when replacing it with another source.
Relate cannot detect a different SQLite file substituted under the same ID.
Switching identity modes requires adoption in the new scope and does not reuse
the old scope's identities or retained observations.

Current bindings use shared service credentials. Your host separately
authenticates callers and supplies their roles and claims to `relate.as()`.
Per-caller delegated provider credentials are not implemented. Keep credentials
in server-side setup and connector configuration, outside the graph definition.

## Writing a Connector

Implement the resource contract from `relate/connectors`. This sketch uses an
application-owned API client whose `account` method verifies the authenticated
account and whose `lookup` method normalizes provider outcomes:

```ts
import { SourceAccessDenied, type SourceConnector } from 'relate/connectors';

const connector: SourceConnector = {
  async identify({ signal }) {
    return api.account({ signal });
  },
  async fetch(sourceRecordId, { signal }) {
    const result = await api.lookup(sourceRecordId, { signal });
    if (result.kind === 'denied') throw new SourceAccessDenied();
    if (result.kind === 'unavailable') throw new Error('Source unavailable');

    // result.accountId must come from authenticated provider evidence.
    if (result.kind === 'deleted') {
      return { providerAccountId: result.accountId, state: 'deleted' };
    }
    return {
      providerAccountId: result.accountId,
      state: 'present',
      record: result.record,
    };
  },
};
```

`api` is a placeholder for your integration, not a Relate API. Normalize its
records to JSON values matching your source schema and preserve the requested
source key in its ID field. Identity and fetch evidence must describe the same
authenticated account, including during credential rotation. Honor the abort
signal in credential resolution and I/O; sanitize provider failures so errors do
not expose tokens or response bodies.

## Provider Outcomes

| Outcome                              | Connector behavior                        | Runtime consequence                                                                      |
| ------------------------------------ | ----------------------------------------- | ---------------------------------------------------------------------------------------- |
| Record exists                        | Return `state: 'present'` with the record | Validate, retain, authorize, and resolve fields                                          |
| Confirmed deletion                   | Return `state: 'deleted'`                 | Do not replay an older present observation                                               |
| Explicit access denial               | Throw `SourceAccessDenied`                | Never use retained data to bypass that denial                                            |
| Temporary outage or invalid response | Throw an ordinary sanitized error         | Retained values may be used under the read's freshness options and current access checks |

A provider 404 or empty result is not automatically proof of deletion. Establish
what that provider guarantees; it may hide inaccessible records the same way.
The built-in connector READMEs document their different deletion and denial
rules. Return `version` only when the provider offers a real per-record ordering
contract; request IDs and creation timestamps do not establish one.

The host still needs to
[adopt known source IDs](../runtime/reading-data.md#2-adopting-source-records)
before consumers can query or traverse them. A connector's `fetch` method does
not imply discovery of other records.
