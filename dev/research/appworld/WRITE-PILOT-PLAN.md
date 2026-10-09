# Write-action pilot: frozen protocol

Scope: retain raw Python, static-notes Python, raw TypeScript and Relate
TypeScript. Add two research-authored actions, `likeTransaction` and
`commentOnTransaction`, using the existing public `defineAction`,
`implementAction` and consumer APIs. The host calls original Venmo operations
and reads the changed transaction back. Refresh observations in the same
runtime; retain canonical IDs and action receipts. No Relate package files have
been changed.

Fixed run `sdk-nano-writes-v1`: `afc0fce_1`, `afc0fce_2` (training write
variants) and `d0b1f43_1` (existing read control), four conditions, two repeats,
nano, current 14-turn budgets. This is a diagnostic subset, not a held-out
benchmark score. Do not begin the run until the boundary issue below is resolved
and smoke checks pass. No model calls have been made for this increment.

## Initial blocker evidence (before main fix)

- Existing 17 Python unit tests pass.
- Two Node graph tests pass, including successful action execution, updated
  counts in subsequent get/query reads, receipt replay without a duplicate
  handler call, conflicting-key rejection and invalid-reference rejection.
- The real AppWorld write smoke fails before a Venmo write:
  `ActionError: invalid`.
- `node dev/research/appworld/test/action_realm_repro.mjs` reproduces the exact
  cause without AppWorld, credentials or benchmark records.

The persistent REPL evaluates code in a separate Node VM context. A plain object
literal there has that context's `Object.prototype`. The SDK action parser in
`packages/runtime/src/actions/execute.ts:56` requires identity with the host's
`Object.prototype`. Thus identical JSON-shaped inputs differ only by where they
were created: host input succeeds, REPL input fails, host-cloned REPL input
succeeds. The action handler is never reached for the rejected input.

Resolution: main commit `5a0af21` supplies cross-realm plain-object validation.
It has been merged and rebuilt. The diagnostic now checks all three input forms
succeed, without a research input-normalization wrapper.

## Important limits of the proposed actions

Successful same-key replay suppresses duplicate source writes within the live
runtime. It is not durable exactly-once execution against Venmo: an external
write and a local receipt cannot commit atomically. A write followed by failed
readback must be reported as a potentially partial outcome, not assumed rolled
back. There is no source-wide synchronization or concurrent-writer guarantee in
this small snapshot experiment. Only the two fixed mutations on acquired own
transactions are bridged; original APIs and credentials remain absent from the
SDK agent's global environment.

All new implementation edits remain in this research folder. Results will be
reported separately from previous read-only runs. The shared SDK prompt now
includes generic action discovery and invocation syntax, without domain-specific
action names or task-solving hints. Python and raw TS prompts are unchanged.
