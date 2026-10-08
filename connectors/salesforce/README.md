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
[development model](../../dev/salesforce/model.ts) for complete composition.

## Failure and access contract

- `identify()` and `fetch()` use a whole-operation deadline (default 10 seconds)
  covering credential resolution, identity, response streaming, and parsing.
  `timeoutMs` overrides it; `maxResponseBytes` defaults to 2 MiB per response.
  Caller cancellation reaches credentials and HTTP requests.
- HTTP 401/403 and Salesforce permission/session errors throw
  `SourceAccessDenied`. `INVALID_FIELD` and `INVALID_TYPE` are conservatively
  treated as denial because object/field permissions can cause these errors.
  Missing selected fields and empty query results also deny access: an empty
  result can mean sharing was revoked. These outcomes cannot replay cached data.
- `queryAll` provides affirmative soft-deletion evidence: only a matching
  Account with `IsDeleted: true` returns
  `{ state: 'deleted', providerAccountId }`. Hard-deleted or invisible rows
  cannot prove deletion. An empty result denies access without inventing a
  tombstone. HTTP 404 is an unavailable lookup.
- Rate limits, server errors, timeouts, invalid JSON, and malformed records
  throw a sanitized `SalesforceSourceError`. Relate may retain authorized stale
  values according to its read policy. The connector does not retry or refresh
  tokens.
- Field values retain Salesforce JSON values; unsafe numeric integers are
  rejected. Response shape, record identity/type, and completeness are checked.
  Unselected fields and Salesforce `attributes` are not returned.

## Contributor setup

Salesforce CLI is optional for connector consumers. The repository development
harness uses the CLI and a persistent Dev Hub to provision disposable scratch
orgs; it never uses the Dev Hub as the connector's data source.

1. Create a [Developer Edition account](https://developer.salesforce.com/signup)
   and
   [enable Dev Hub](https://developer.salesforce.com/docs/platform/sfdx-dev/guide/sfdx-setup-enable-devhub.html).
2. Install
   [Salesforce CLI](https://developer.salesforce.com/tools/salesforcecli). This
   harness was verified with CLI 2.153.5, including
   `sf org auth show-access-token`.
3. Authenticate the default Dev Hub:

   ```sh
   sf org login web --alias relate-hub --set-default-dev-hub
   ```

From the repository root:

```sh
# Create, seed, explore interactively, and delete on normal exit or Ctrl-C.
pnpm example:salesforce

# Same lifecycle, print seeded customers once and exit.
pnpm example:salesforce --once

# Explicitly retain one org across development commands.
pnpm salesforce:dev create
pnpm example:salesforce --existing
pnpm salesforce:dev reset
pnpm salesforce:dev delete

# Separately selected live suite: creates one org, shares it, deletes in finally.
pnpm test:salesforce:live

# Deterministic local tests: no CLI, credentials, provisioning, or network.
pnpm test:unit -- connectors/salesforce/test
```

The retained example does not own the org lifecycle; use `salesforce:dev delete`
when finished. Reset deletes only recorded fixture Account IDs and seeds
Northwind/Contoso automatically. Do not run reset/delete while an example or
live suite is using the org. A second create refuses to overwrite existing
state. All commands use the worktree-local `.relate/salesforce.json` ownership
record. It contains the Dev Hub identity, unique scratch username, creation job
ID, org ID, and seeded Account IDs, **never access tokens**. Do not remove it
before teardown. Do not edit its ownership fields or move it between worktrees.

The harness records intent before provisioning and recovers a lost creation
response through the Dev Hub's `ScratchOrgInfo`. Before seeding, credential
retrieval, or deletion it checks the recorded identity against the CLI's scratch
org inventory and the owning Dev Hub; a Dev Hub or unrelated org is refused.
Normal runner exit, handled interruption, and setup/assertion failures attempt
cleanup. Signals wait for the current CLI command to settle before cleanup.
Failed cleanup keeps the recovery record and reports
`pnpm salesforce:dev delete`. A crash, SIGKILL, or network outage may require
that command on the next run. Scratch orgs expire after **one day** as a
backstop. Active-org and daily creation allocations still apply; reuse/reset
retained orgs during development.

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
