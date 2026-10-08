# @relate/connector-salesforce

Planned read-only Salesforce connector for Relate. Implementation is tracked in
[TODO.md](TODO.md); this directory does not yet contain a usable package.

## Salesforce CLI and authentication

Using the connector will not require Salesforce CLI. The connector will use
Salesforce API credentials supplied by the host application; its public
configuration API is still to be implemented.

Salesforce CLI is recommended for local development. Our development workflow
uses an authenticated **Dev Hub** account to create, seed, and delete disposable
**scratch orgs** hosted by Salesforce. The CLI is development tooling, not a
connector runtime dependency.

To prepare that workflow:

1. Create a
   [free Salesforce Developer Edition account](https://developer.salesforce.com/signup).
2. In Salesforce, open **Setup**, search for **Dev Hub**, and enable it.
3. Install
   [Salesforce CLI](https://developer.salesforce.com/tools/salesforcecli).
4. Authenticate the Dev Hub through the browser:

   ```sh
   sf org login web --alias relate-hub --set-default-dev-hub
   ```

The CLI manages its OAuth authentication; this local login flow does not require
manually copying API keys. The Dev Hub authorizes provisioning. Relate examples
and live tests must use each scratch org's own credentials and verified org
identity to read its seeded data.

See Salesforce's
[Dev Hub setup guide](https://developer.salesforce.com/docs/platform/sfdx-dev/guide/sfdx-setup-enable-devhub.html)
and
[CLI browser authentication guidance](https://developer.salesforce.com/docs/platform/sfdx-dev/guide/sfdx-dev-auth-eca.html).

## Examples and tests

The planned development harness will create a scratch org, apply required
configuration, and seed representative records automatically. These environments
serve two purposes:

- Interactive examples where people can explore Relate against real Salesforce
  data, with seed/reset and explicit teardown commands.
- A small, separately selected live integration suite for the Salesforce
  connector. The normal test suite will use deterministic local fixtures and
  will not require Salesforce access or create scratch orgs.

The connector's initial scope is read-only. Creating and updating fixture data
is the responsibility of the development harness.

Scratch orgs must be deleted after use, including after setup or test failure. A
short expiration provides a backstop if cleanup is interrupted. Stopping a local
process alone does not delete an org. Dev Hub creation and active-org
allocations also apply, so interactive work should reuse/reset an org and live
tests should provision at suite scope rather than for every test case.

Harness commands will be documented here when implemented. See Salesforce's
[scratch org lifecycle](https://developer.salesforce.com/docs/platform/sfdx-dev/guide/sfdx-dev-scratch-orgs.html)
and
[fixture data import](https://developer.salesforce.com/docs/platform/sfdx-dev/guide/sfdx-dev-data-tree.html)
documentation.
