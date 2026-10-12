# Troubleshooting

Start with the operation's result or structured error. Missing records, withheld
fields, provider failures, and compilation errors have different meanings.

## Queries Return No Records

Queries enumerate graph members, not all records in a provider. Adopt known
source IDs with `relate.host.adopt(Object, sourceKey)` before querying. Native
records must have been created by an action. Check the caller's roles, claims,
and filters next. An empty page with `meta.exhausted: false` requires another
page; use its cursor or `for await`.

See [queries](../runtime/reading-data.md#querying-objects-query).

## A Known Record Returns `not-found`

Use the Relate object ID returned by adoption or creation, not the provider's
source key. Verify the binding's identity and the host-supplied principal. A
hidden record and a missing record deliberately return the same result;
unavailable policy evidence can also prevent access. Do not treat `not-found` as
proof of source deletion.

Inspect the host's configuration and provider access rather than exposing
private policy details to the caller. [Discovery](../runtime/discovery.md) shows
static capabilities, but cannot promise access to a particular record.

## Selected Fields or Reference Targets Are Missing

Check `meta.fields?.[name]`, or repeat the read with `evidence: 'full'`.
`forbidden` means field access was withheld; `unavailable` means a value cannot
be supplied. A reference target must already be in the graph and readable by the
caller. A hidden target and a missing target both withhold the reference.

`requireComplete: true` throws `ReadError('incomplete')` for forbidden or
unavailable fields. A known absent optional field still counts as complete. Use
`assertFields(result, ['name'])` when your code needs a present value. It
accepts legitimate `null` values; check those separately when your application
requires a non-null value. See [Read Responses](./read-responses.md).

## Refresh Fails or Returns Stale Data

`refresh: true` requests new source data; it does not make a provider available.
Temporary failures can allow retained values under `stale: 'allow'` (the
default), provided current access is established. Use `stale: 'omit'` to
withhold those values. Explicit provider denial never allows stale fallback.

Check both runtime and connector deadlines, provider identity, credentials, and
the connector's documented error outcomes. See
[Connecting Sources](../authoring/connections.md#provider-outcomes). Returned
data freshness and policy evidence age are separate settings.

## A Request Is Rejected

`ReadError('invalid-request')` includes `operation`, `issues`, and sometimes
`acceptedOptions`. Use `limit` and opaque cursors for pagination; offset and
page-number options are unsupported. Cursors are bound to the original request
context and can expire. Restart the query if the context changed.

A traversal hidden by static access rules rejects the same way as an unknown
traversal. Use [discovery](../runtime/discovery.md) to learn available calls and
the [request-error reference](./read-responses.md#request-errors) for issue
types.

## The Model Does Not Compile

`compile` reports independent issues together. Inspect codes and paths instead
of parsing human-readable messages:

```ts
import { CompileError } from 'relate';
import { compile } from 'relate/compiler';

try {
  compile(graph); // your authored graph
} catch (error) {
  if (!(error instanceof CompileError)) throw error;
  for (const issue of error.issues) {
    console.error(issue.code, issue.message, issue.path);
  }
}
```

Check that every object has a read policy, references target registered objects,
field groups and roles exist, and schema features are portable. The
[Inspector](../authoring/inspector.md#editing-and-troubleshooting) displays
model diagnostics while retaining the last good graph. Detailed diagnostic
contracts are in the
[authoring package](../../../../packages/relate/README.md#diagnostics).

## Postgres Reports an Installed Model Difference

`Installed model differs; explicit migration required` means the stored graph ID
is pinned to a different definition revision. This can follow a policy,
property, relationship, or description change. Storage schema migration through
`store.migrate()` does not migrate a graph definition.

Model-revision migration is not implemented. For experimentation, use a
different `graphId` or a fresh development database; existing data stays under
the old installation and is not transferred automatically. See
[revision pinning](../deployment/postgres.md#2-definition-revision-pinning).

## An Action Response Was Lost

Retry with the original input and idempotency key. Do not generate a new key for
the same attempt. If you have the invocation ID, use `receipts.get` with the
action definition. Recovery requires the originating actor and current access;
an inaccessible receipt returns a sanitized rejection. A declared business
failure returns a failed receipt, whereas an unexpected handler error rejects
without recording one. See
[Actions](../runtime/actions.md#idempotency-and-replay).
