# Recovering external writes

The SDK's `ActionContext.operationId` addition from
[PR #24](https://github.com/relatehq/relate/pull/24) has landed in main and is
merged into this research branch at `cd1a789`. Build normally with `pnpm build`;
no SDK artifact overlay is needed. This PR adds no core SDK changes beyond main.

## Confirmed mutation, pending refresh

The Python bridge reserves a journal entry before dispatch, then records the
provider's confirmed result before trying to read the transaction back. Its
SQLite journal is independent of Relate's native transaction and receipt store.
A failed readback now returns a successful action receipt with the confirmed
comment ID and `refreshState: 'pending'` instead of throwing away the write
result.

```ts
const request = {
  input: { transaction: tx.id, comment: 'Thanks!' },
  idempotencyKey: 'comment-1',
};
const receipt = await relate.actions.commentOnTransaction(request);
// receipt.output:
// { message: '...', commentId: '99', operationId: 'relate-op-v1-...',
//   refreshState: 'pending' }

const replay = await relate.actions.commentOnTransaction(request);
// Same receipt, no new provider write or readback.

const refresh = await relate.actions.refreshTransaction({
  input: { transaction: tx.id },
  idempotencyKey: 'refresh-1',
});
// Read only. If output.refreshState is still 'pending', retry this refresh
// action with a NEW key, for example 'refresh-2'.
```

A transaction's `syncState` is `pending` while its counts may be stale.
`current` means the last acquisition or explicit readback was observed
successfully; this is still a snapshot and does not subscribe to later provider
changes. Readback rows are validated before replacing the last valid source row.
Graph refresh failure cannot erase the journaled provider result.

If the bridge response or SDK receipt commit fails after the provider result was
journaled, repeating the original write request with the original key returns
that result and attempts readback without dispatching another write.

## Uncertain mutation

If the provider call raises, its response is malformed, or recording the result
fails, the reservation remains unresolved. The action throws `ActionError` with
code `uncertain`. Repeating that request never dispatches again; changing its
input under the same operation ID produces `conflict` even if no SDK receipt was
committed. A changed idempotency key is a new business operation and can
duplicate the original write, so it must not be used to bypass uncertainty.

There is no provider idempotency/operation-lookup integration here. An operator
must inspect the original provider state to reconcile an unresolved reservation.
A refreshed comment count alone cannot identify which operation created a
comment; `refreshTransaction` does not clear uncertainty. The harness
deliberately provides no automatic "clear and retry" path.

## Journal scope and lifetime

Normal episodes store `source-writes.sqlite3` under their existing ignored
`.local/runs/<run>/<episode>/` directory. Direct `NodeRepl` usage creates a
unique ignored `.local/write-journals/<uuid>.sqlite3` by default. Pass the same
explicit `journal_path` when reconnecting to the **same AppWorld state**. Do not
reuse an episode journal against a reset world. Journal files are bound to the
provider account email; opening one for another account is rejected.

Entries retain operation identity, input and confirmed output, including
protected benchmark text. They contain no access tokens, remain host-only, and
must follow the existing encrypted-artifact policy. Do not remove them while
recovery is needed. A reservation is committed before dispatch, so a crash
before the actual POST can conservatively leave an uncertain operation too. This
is intentional: without provider reconciliation, avoiding duplicates takes
precedence over blindly retrying an ambiguous dispatch.

## Regression checks

```sh
node --test test/*.test.mjs
.venv/bin/python -m unittest discover -s test -p 'test_*.py' -v
.venv/bin/python test/sdk_write_smoke.py
```

The tests cover failed readback, original-key receipt replay, explicit refresh,
invalid readback data, response loss after journaling, provider-response loss,
reopening the journal, an interrupted reservation, conflicting input and account
isolation. The smoke runs only against a local AppWorld training state.

Before PR 24 landed, validation used its ignored built SDK artifacts. That
overlay is obsolete: this branch now contains main's SDK changes and uses the
normal build. Historical experiment results predate this protocol and have not
been rerun or reinterpreted as evidence for the fix.

## Spotify expansion

`music_writes.py` uses a separate `music-writes.sqlite3` in the same episode
folder, with the same account binding and durable reservation/result ordering.
It dispatches only the 14 allowlisted music operations in `music-model.mjs`.
Canonical graph references are resolved host-side to acquired source IDs; the
agent never receives an arbitrary original-API proxy or provider token.

For state-setting operations (likes, downloads, follows and membership changes),
a public read checks whether the desired state already exists. In that case the
operation records a successful no-op. `rateSong` reads the account's existing
review before choosing create or update, and preserves review title/text on
update. These preflight reads occur before any write reservation.

The provider result is recorded before a complete public-API music readback.
Valid readback replaces music source maps, adopts newly created records, and
refreshes removed memberships as deleted. A failed readback leaves the confirmed
result intact and marks music records `syncState: pending`. `refreshMusic` with
a new key retries reads only. An uncertain operation remains uncertain even
after refresh; changing the key can duplicate playlist creation or
queue/navigation operations and must not be used as a recovery mechanism.

```sh
.venv/bin/python test/expanded_write_smoke.py
.venv/bin/python -m unittest discover -s test -p 'test_music_writes.py'
```
