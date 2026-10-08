# Salesforce customers

Read seeded Salesforce Accounts as Relate Customers, then press Enter to refresh
from Salesforce while exploring. The application maps `Name` to `Customer.name`
and `Website` to `Customer.website`; its employee policy gates reads.

```sh
pnpm example:salesforce        # creates/seeds an org; q or Ctrl-C deletes it
pnpm example:salesforce --once # prints once, then deletes the org
```

For repeated use without spending a new scratch-org allocation each time:

```sh
pnpm salesforce:dev create
pnpm example:salesforce --existing
pnpm salesforce:dev reset
pnpm salesforce:dev delete
```

`--existing` leaves the org available after exit. Do not reset while the example
is running: reset creates new Account IDs. Restart the example after a reset.

The example consumes shared development tooling in `dev/salesforce/`; no
connector or test depends on example code. The default runner registers cleanup
before setup, retains recovery state on failure, and uses a one-day expiration
as a backstop. See
[connector setup and lifecycle guidance](../../connectors/salesforce/README.md).
