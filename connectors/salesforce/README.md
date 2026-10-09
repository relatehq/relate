# @relate/connector-salesforce

Read Salesforce Accounts as application-owned Relate objects. A support team can
adopt known Account IDs, read their customers through Relate policies, and
refresh those customers after Salesforce changes. This first slice is read-only:
no record discovery, continuous sync, webhooks, or provider writes.

## Connect

```ts
import { salesforce } from '@relate/connector-salesforce';
import { connect } from 'relate';

const crm = salesforce({
  // Resolve one matching pair from your server-side OAuth credential store.
  // Refresh expired tokens there. Never accept instanceUrl from a request body.
  credentials: async ({ signal }) => getSalesforceCredentials({ signal }),
  apiVersion: '67.0',
});

const accounts = crm.resource('Account', { fields: ['Name', 'Website'] });

// In defineApp.setup():
const connection = connect(accountSource, {
  connectionId: 'salesforce-crm',
  providerAccountId: expectedOrgId, // canonical 18-character Salesforce org ID
  connector: accounts,
});
```

`getSalesforceCredentials`, `accountSource`, and `expectedOrgId` above are
supplied by your application. Credentials are `{ instanceUrl, accessToken }`; a
static pair is also accepted. `instanceUrl` must be an HTTPS origin with no
path, credentials, query, or fragment. Redirects are refused. The runtime
package has no Salesforce CLI dependency and does not log or persist tokens.
Your host owns OAuth authorization, token refresh, and trusted configuration.

The connector verifies `/services/oauth2/userinfo` on every operation, using the
same credentials as the Account request. It returns the canonical org ID as
`providerAccountId`; Relate checks this against the expected binding. Account
and org IDs can arrive in case-sensitive 15-character form or canonical,
case-preserving 18-character form. The connector checks 18-character checksums.
An adopted 15-character source ID is preserved in the returned record; use one
consistent ID form when adopting records to avoid duplicate Relate objects.

Select top-level Account API field names (including custom fields). Relationship
paths and SOQL expressions are not supported. `Id` and `IsDeleted` are always
selected. No source version or ordering is inferred from Salesforce timestamps.
The application owns its source schema, property mappings, and access policies:

```ts
const accountSource = defineSource({
  id: 'salesforce.accounts',
  idField: 'Id',
  schema: z.object({
    Id: z.string(),
    IsDeleted: z.boolean(),
    Name: z.string(),
    Website: z.string().nullable(),
  }),
});

// Inside Customer.properties:
// name: from(accountSource.fields.Name, { id: 'customer.name' })
```

See the [runnable example](../../examples/05-salesforce/README.md) and its
[application model](../../examples/05-salesforce/src/model.ts) for complete
composition.

## Failure and access contract

- `identify()` and `fetch()` use a whole-operation deadline (default 10 seconds)
  covering credential resolution, identity, response streaming, and parsing.
  `timeoutMs` overrides it; `maxResponseBytes` defaults to 2 MiB per response.
  Caller cancellation reaches credentials and HTTP requests.
- HTTP 401/403 and Salesforce permission/session errors throw
  `SourceAccessDenied`. Salesforce reports a misspelled field and one hidden by
  field-level security with the same `INVALID_FIELD`/`INVALID_TYPE` code, so
  these throw `SalesforceSelectionDenied`, a `SourceAccessDenied` subclass whose
  `errorCode` and message point at the selection. Missing selected fields and
  empty query results also deny access: an empty result can mean sharing was
  revoked. These outcomes cannot replay cached data.
- Field names are case-insensitive, as in Salesforce. Each field is selected
  once, and the record uses the spelling you passed (`Id` and `IsDeleted` keep
  theirs).
- `queryAll` provides affirmative soft-deletion evidence: only a matching
  Account with `IsDeleted: true` returns
  `{ state: 'deleted', providerAccountId }`. Once a record is purged from the
  Recycle Bin, Salesforce returns the same empty result as for a record the user
  cannot see, so a purge reads as denial rather than deletion; neither replays
  cached data. HTTP 404 is an unavailable lookup.
- Rate limits, server errors, timeouts, invalid JSON, and malformed records
  throw a sanitized `SalesforceSourceError`, which keeps the HTTP status even
  when an error page is not JSON. Relate may retain authorized stale values
  according to its read policy. The connector does not retry or refresh tokens.
- Field values retain Salesforce JSON values; unsafe numeric integers are
  rejected. Response shape, record identity/type, and completeness are checked.
  Unselected fields and Salesforce `attributes` are not returned.

## Development and Validation

Salesforce CLI is not required by connector consumers. To run the example or
contribute live tests, see
[Salesforce development tooling](../../dev/salesforce/README.md) for Dev Hub
prerequisites, scratch-org ownership, cleanup, and recovery. The
[learning example](../../examples/05-salesforce/README.md) owns the application
model and interactive reads.

Live tests cover verified identity, seeded reads through Relate, upstream
updates, invalid-session denial, and soft deletion. Local tests cover
sharing-like empty results, field/object denial, org changes, transport and
validation failures, and cleanup safeguards. The live suite does not configure
restricted Salesforce profiles or exhaustively test sharing/FLS permutations.
Installed-tarball checks exercise this package under plain Node ESM and
TypeScript NodeNext without CLI.

## Salesforce references

- [REST API resources](https://developer.salesforce.com/docs/platform/api-rest/guide/resources-list.html)
- [UserInfo endpoint](https://help.salesforce.com/s/articleView?id=sf.remoteaccess_using_userinfo_endpoint.htm&language=en_US&type=5)
- [QueryAll and deletion](https://developer.salesforce.com/docs/platform/api/guide/sforce-api-calls-queryall.html)
- [Scratch-org creation and resumption](https://developer.salesforce.com/docs/platform/salesforce-cli-reference/guide/cli_reference_org_create_scratch.html)
