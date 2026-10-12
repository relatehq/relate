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
