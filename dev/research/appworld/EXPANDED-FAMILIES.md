# Additional single-app families: Haiku, raw Python and Relate SDK

## Frozen protocol

Scope: the 69 instances in the 23 additional single-app families listed in
`task_catalog.ADDITIONAL_TASKS` (22 Spotify families, one Venmo family).
Existing 12 instances are not rerun. One attempt per instance/interface on
`claude-haiku-5-5`, using raw Python (`raw`) and Relate SDK (`sdk`): **138
attempts**. No retries, repeat baselines, holdouts or confirmation rounds. Both
interfaces use the same task worlds, seed 100, low reasoning, 28 turns, 4,096
output tokens per request, 14,000 generated tokens per episode and 14,000
visible output characters. Execution timeout is 60 seconds; three isolated
episode processes. The batch reserves at most $1 per episode under a $20
aggregate ceiling.

Acquisition is fixed across SDK episodes, with no task routing. The raw
interface acquires through original APIs. Models receive task instructions and
public supervisor/date context, never reference solutions or evaluator
internals. Sources and built SDK files are hashed before dispatch. Each process
retains its source copy, request/response bodies, usage, code, output, final
world and official score. Incomplete attempts stay visible with null success;
failures are retained.

## Reproduction

From the repository root:

```sh
dev/research/appworld/.venv/bin/python dev/research/appworld/two_model_eval.py \
  --batch expanded-haiku-20261012 --task-set expanded \
  --models claude-haiku-5-5 --conditions raw sdk \
  --credentials /path/to/local/.env --jobs 3 --max-cost-usd 20
```

A batch name cannot be reused. Credentials remain host-only. Validation uses
`test/expanded_preflight.py`, `test/expanded_write_smoke.py`, Python research
tests and Node research tests. Preflight is not a model attempt or an official
score.

## Results

All **138 attempts** completed from frozen commit `8a14a4e` (69 instances × two
interfaces on Haiku), with **117 passes, 21 failures and zero incomplete
attempts**. No attempt was rerun. The wall-clock batch duration was 15m 52s. The
original 12 selected instances were not rerun.

| Interface  | Passed | Failed | Incomplete | Mean turns | Estimated model cost |
| ---------- | -----: | -----: | ---------: | ---------: | -------------------: |
| Raw Python |  65/69 |      4 |          0 |       5.70 |              $0.3167 |
| Relate SDK |  52/69 |     17 |          0 |      10.84 |              $1.0240 |

All **1,141 model requests** have retained provider usage; total estimated model
cost was **$1.34064**. Costs exclude local compute.

### By task family

| Family    | Capability                                                | Raw Python | Relate SDK |
| --------- | --------------------------------------------------------- | ---------: | ---------: |
| `692c77d` | Rate songs using personal likes and library membership    |        3/3 |        1/3 |
| `287e338` | Aggregate recommended songs by artist                     |        3/3 |        3/3 |
| `27e1026` | Compare release dates across personal music collections   |        3/3 |        3/3 |
| `b7a9ee9` | Follow artists selected by playlist song genre            |        3/3 |        3/3 |
| `ce359b5` | Remove songs from libraries and playlists by release date |        2/3 |        1/3 |
| `229360a` | Clean saved collections using likes and download state    |        3/3 |        2/3 |
| `e3d6c94` | Create playlists from filtered recommendations            |        3/3 |        2/3 |
| `ccb4494` | Like songs through the current queue position             |        3/3 |        3/3 |
| `07b42fd` | Follow catalog artists by genre and follower count        |        3/3 |        3/3 |
| `c901732` | Play songs selected from album or playlist statistics     |        3/3 |        1/3 |
| `e85d92a` | Compare public song popularity for an artist              |        3/3 |        3/3 |
| `aa8502b` | Follow or unfollow artists using personally liked songs   |        3/3 |        2/3 |
| `50e1ac9` | Rank personal-library songs by genre and play count       |        3/3 |        3/3 |
| `fac291d` | Count distinct songs across personal music collections    |        3/3 |        3/3 |
| `4ec8de5` | Count saved songs and album songs by release period       |        3/3 |        3/3 |
| `b119b1f` | Navigate the player queue to an artist                    |        3/3 |        3/3 |
| `d4e9306` | Follow artists associated with liked songs and albums     |        3/3 |        1/3 |
| `3ab5b8b` | Download liked songs from a selected collection           |        0/3 |        1/3 |
| `23cf851` | Aggregate transaction likes by direction and date         |        3/3 |        3/3 |
| `57c3486` | Like catalog songs by followed artists                    |        3/3 |        0/3 |
| `6bdbc26` | Inspect followers of the current song artist              |        3/3 |        3/3 |
| `6171bbc` | Build playlists from per-collection song rankings         |        3/3 |        2/3 |
| `396c5a2` | Queue artist songs selected by public play count          |        3/3 |        3/3 |

### Failure interpretation and subsequent fixes

Raw Python's four failures all submitted completion but failed the official
score. SDK failures comprise twelve completed-but-incorrect attempts, four
28-turn budget failures, and one 60-second execution timeout. A submitted
completion is therefore not a success claim.

The frozen batch exposed two concrete integration/harness gaps:

1. The SDK exposed public average song ratings but not the account's own
   existing rating. The conditional-rating trace `692c77d_3` filtered using the
   public average. The adapter now exposes nullable `SongState.personalRating`
   separately from public `rating`, populated from the account's own reviews.
2. AppWorld resets the API request quota for each Python execution cell, but the
   Node bridge did not reset it between cells. Four failed SDK traces explicitly
   contain the request-limit error: `ce359b5_2`, `ce359b5_3`, `3ab5b8b_1`, and
   `57c3486_3`. The bridge now resets the quota at each Node cell, preserving
   the complete request history. It still enforces the same quota within a cell.

Both fixes were committed in `14eca54`, **after all 138 attempts and the
source/usage audit**. They have offline regression/preflight coverage but **no
new model evaluation**. The reported scores are for `8a14a4e`, not the final
corrected adapter. Original trajectories, scores and frozen sources are
unchanged. No improvement from these fixes is claimed without another authorized
evaluation.

Other traces contain invalid query limits, persistent-REPL redeclarations and
partial collection handling. The SDK's full music readback after each mutation
also adds source calls and can exhaust execution budgets during large loops.
This selected, single-attempt comparison includes host acquisition, graph
modeling and the harness limitations above; it is not a causal estimate of the
core SDK's effect or a benchmark-wide result. Raw Python performed better on
this frozen batch.

### Failure clusters and paired comparison

This post-run analysis uses the frozen trajectories, model-visible outputs and
official evaluation records, including the paired Python runs. It introduces no
model attempts or changes to scores. Primary causes below are analyst
classifications; secondary causes overlap, and a proposed repair is not proof
that an episode would pass. The derived counts and per-instance annotations are
retained in
[the failure-analysis record](evidence/expanded-haiku-20261012-failures.json).

| Paired outcome           | Instances |
| ------------------------ | --------: |
| Both pass                |        51 |
| Python passes, SDK fails |        14 |
| SDK passes, Python fails |         1 |
| Both fail                |         3 |

| Primary SDK failure cluster                   | SDK failures | Paired Python passes |
| --------------------------------------------- | -----------: | -------------------: |
| Pagination and recovery from incomplete reads |            9 |                    9 |
| Bulk-write readback and request quota         |            4 |                    2 |
| Missing personal-rating information           |            1 |                    1 |
| Incorrect task completion                     |            2 |                    2 |
| Wrong selection semantics                     |            1 |                    0 |
| Total                                         |           17 |                   14 |

#### Pagination and recovery: nine failures

Every SDK episode's initial `relate.describe()` output was 20,629 characters.
The harness's 14,000-character visibility limit cut off the common operation
contracts, including cursor placement and the built-in async iterator example.
The full stored output contains those instructions; the model-visible output
does not. None of the 69 SDK episodes used `for await` in submitted code. This
is a confirmed presentation defect and a plausible contributor to the mistakes
below, not a measured causal effect on nine outcomes.

Agents guessed `nextCursor`, a top-level `continuationCursor`, or other cursor
shapes. The documented cursor is `page.meta.continuationCursor`. The existing
SDK can handle paging without manual cursor code:

```js
for await (const row of relate.objects.SongState.query({
  where: { liked: true },
})) {
  // Each matching record across all pages.
}
```

The runtime also bounds query scans to 100 candidates per page. A selective
query can return fewer than `limit` records, or none, with `exhausted: false`.
The caller must continue. Record-level `completeness: 'complete'` and
`requireComplete: true` concern fields; neither means a collection is exhausted.
These distinctions are documented in
[the read contracts](../../../packages/runtime/src/contracts.ts) and
[read options](../../../packages/runtime/src/reads/options.ts), and implemented
in [query scanning](../../../packages/runtime/src/queries/query.ts).

| Instance    | Observed failure                                                                                                                                                | Decisive SDK turns |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------ |
| `692c77d_2` | Wrong cursor repeatedly fetched the first page; incomplete liked-state information caused four extra songs to receive ratings.                                  | 6–10               |
| `229360a_1` | Wrong cursor repeatedly fetched the first page until the 60-second execution timeout, before any mutation.                                                      | 5–7                |
| `e3d6c94_2` | Read only nine of 30 recommended song records and added one of five required songs to the new playlist.                                                         | 7–11               |
| `aa8502b_3` | Stopped paginating liked songs and artist links; followed five of 13 required artists.                                                                          | 5–8                |
| `d4e9306_2` | Partial liked-song and association reads omitted six required artists.                                                                                          | 5–9                |
| `d4e9306_3` | Partial liked-song and association reads omitted 13 required artists.                                                                                           | 5–7                |
| `57c3486_1` | Initially read partial associations; the cursor repair then mixed `globalThis` assignments with existing lexical bindings, leaving stale song/state selections. | 8–14               |
| `57c3486_2` | Stopped after the first association page and acted on only 16 songs.                                                                                            | 6–7                |
| `6171bbc_2` | Partial memberships, ratings and traversal pages appeared to be missing data; refresh did not repair the pagination mistake, and the agent submitted failure.   | 4–14               |

Python generally exhausted explicit provider collections using page-number
loops, or fetched selected records directly. SDK recovery also encountered
invalid limits, `.catch()` on a lazy query handle, and persistent-REPL
redeclarations. These are secondary friction rather than nine independent
missing-data defects. The query handle is awaitable and iterable, but is not a
full Promise supporting `.catch()`.

#### Bulk-write readback and quota: four failures

The adapter refreshed the entire music snapshot after each mutation. Each of
these episodes reached 1,000 recorded provider requests; the Node bridge then
failed to reset that quota between execution cells. Python reset it per cell.
Successful provider writes could therefore be followed by pending refreshes,
generic `ActionError: internal` failures, and rejected completion calls.

| Instance    | Observed failure                                                                                                              | Paired Python result                                  | Total provider calls, SDK / Python |
| ----------- | ----------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- | ---------------------------------: |
| `ce359b5_2` | Removed saved songs but exhausted the quota partway through playlist removals; subsequent refresh/completion attempts failed. | Pass                                                  |                        1,000 / 125 |
| `ce359b5_3` | Correctly selected both collections, but stopped partway through playlist removals.                                           | Fail: omitted song-library removals                   |                        1,000 / 126 |
| `3ab5b8b_1` | All requested download-state checks passed; only the completion/answer check failed after the quota blocked `completeTask()`. | Fail: selected liked playlists instead of liked songs |                         1,000 / 54 |
| `57c3486_3` | Selected 77 songs; 21 action calls returned success, then 56 returned internal errors. Refresh stayed pending.                | Pass                                                  |                        1,000 / 105 |

These totals include setup/acquisition and all recorded provider requests, not
just mutations. A returned mutation success is not proof that its readback
completed: the last successful write may have `refreshState: pending`. The
quota-reset repair in `14eca54` does not remove the per-mutation full readback
cost or the 1,000-request limit inside a single cell.

#### Missing information: one failure

In `692c77d_3`, the task depended on the account's own existing rating, but the
evaluated graph exposed only the public average. The agent fully paginated the
song states, then filtered on `rating < 4`, skipping three songs that needed new
personal reviews. Python fetched the account's reviews and passed. The adapter
now exposes `personalRating`, separately from public `rating`; no model rerun
establishes the effect of that change.

#### Task completion: two failures

- `c901732_1`: the SDK played the correct song, then submitted its title as an
  answer even though the task expected no answer. Only the answer assertion
  failed; the application-state assertions passed.
- `c901732_2`: the SDK identified the correct song and submitted its title,
  without invoking playback. Both completion and application state were wrong.

Both paired Python runs performed playback and completed without an answer.
These are instruction-following/completion failures, distinct from inability to
select the right song. The SDK had an available playback action.

#### Selection semantics: one shared failure, and the other Python failures

In `3ab5b8b_3`, both interfaces selected liked albums and downloaded every song
from one such album. The required selection was liked songs within saved albums.
Both made the same incorrect seven-song change. The SDK also had pagination and
discovery errors, but its final selection rule was independently wrong.

The other three Python failures were:

- `3ab5b8b_1`: downloaded songs from liked playlists, instead of liked songs
  within the user's playlist library.
- `3ab5b8b_2`: downloaded liked songs without intersecting the saved-song
  library. This was the SDK's sole exclusive win: it correctly applied the
  intersection and skipped already downloaded songs.
- `ce359b5_3`: removed matching songs from playlists but omitted the separately
  requested song-library removals.

#### Interpretation and remaining cost

Both interfaces passed all **24 read-only instances**. All failures were among
the **45 instances requiring mutations**: Python passed 41/45 and SDK 28/45. The
read-only families are `287e338`, `27e1026`, `e85d92a`, `50e1ac9`, `fac291d`,
`4ec8de5`, `23cf851`, and `6bdbc26`; each has three instances.

Among the **51 instances both passed**, Python averaged 5.35 turns and cost
$0.2111 in total; SDK averaged 9.57 turns and cost $0.6035 in total, **2.86×**
the model cost. This is a descriptive subset, not a controlled causal estimate.
The overhead remains even when failed episodes are excluded.

The traces identify concrete integration, discovery and collection-handling
problems. They do not show that correcting those problems would make Relate
outperform Python, or that graphs are unnecessary in other workloads. Official
scores remain unchanged, including the two SDK failures whose requested
application-state assertions passed (`3ab5b8b_1` and `c901732_1`).

### Follow-up checklist

These are recorded follow-ups, not changes implemented by this analysis. Core
SDK contract/runtime changes belong in separate PRs; PR #14 owns research
adapter, harness and reporting work.

- [x] Expose the account's personal rating separately from the public average
      (`14eca54`; offline validation only).
- [x] Reset the Node request quota per execution cell while retaining request
      history (`14eca54`; offline validation only).
- [ ] Make essential discovery contracts visible before the inventory can
      exhaust the output budget. Preserve a minimal query/action/iteration
      example; verify the actual model-visible text, not just full stored
      output.
- [ ] Exercise the existing async iterator and make page exhaustion distinct
      from record completeness. Cover empty non-exhausted filtered/traversal
      pages; assess any scan/index or public API redesign separately in a core
      SDK PR.
- [ ] Replace full-catalog readback after each mutation with targeted or batched
      refresh, preserving confirmed-write journaling, uncertainty handling and
      truthful freshness. Measure provider requests as well as model cost.
- [ ] Surface actionable quota/readback errors and test persistent-REPL recovery
      (redeclarations, lazy query handles and lexical versus `globalThis`
      bindings). Keep Node harness changes consistent across relevant comparison
      arms.
- [ ] Check requested state changes and completion submission separately in
      reporting; retain the official score and teach the no-answer completion
      contract without changing evaluator expectations.
- [ ] Before claiming uplift, agree a new evaluation scope and freeze its
      sources/controls. Keep this single-pass batch unchanged; targeted error
      reductions alone do not establish end-to-end improvement.

### Retention and inspection

The audit verifies the exact 138 unique schedule entries, official evaluator
scores, frozen source hashes, usage and cost arithmetic, and request
transcripts. The encrypted archive was restored and all **7,878 files** were
SHA-256 verified. Archive size: 27,505,741 bytes.

- [Audited results](evidence/expanded-haiku-20261012-results.json)
- [Archive verification](evidence/expanded-haiku-20261012-archive.json)
- [Encrypted full trajectories and world outputs](evidence/expanded-haiku-20261012.bundle)
- [Original offline preflights](evidence/expanded-preflight.json)
- [Personal-rating offline preflights](evidence/expanded-final-preflight.json)
- [Final validation and known core-test failure](evidence/expanded-validation.json)

The protected local explorer export is `/tmp/relate-expanded-haiku-20261012`. To
serve it locally:

```sh
python3 -m http.server 8766 --bind 127.0.0.1 --directory /tmp/relate-expanded-haiku-20261012
```

No viewer server was started as part of this batch. The export includes every
attempt's trajectory, raw provider responses, usage and official score. Keep it
local; public redistribution of benchmark content must remain encrypted.

### Validation

- Before the frozen batch: full `pnpm check` passed (997 tests, Postgres and
  installed-package checks), 58 Python research tests, 15 Node research tests,
  69 offline task preflights and the live Spotify mutation smoke.
- The personal-rating acquisition passed 69 offline preflights. After both
  fixes, 60 Python research tests, 15 Node research tests, the live mutation and
  personal-rating readback smoke, and packaging checks passed. The quota-reset
  regression preserves the request history across successful and failed cells.
- The final full check reached 996/997 passing tests but failed the unchanged
  core `packages/node/test/sqlite.test.ts:70` freshness assertion. A focused run
  reproduced it: `expected { status: 'not-found' }`, received `{ status: 'ok' }`
  after deletion with `maxAgeMs: 0`. No core SDK or test files were changed for
  this research expansion. The source freshness check uses a strict age
  comparison, so a same-millisecond read is a possible cause; that explanation
  is an inference, not a repaired or conclusively isolated core defect.
