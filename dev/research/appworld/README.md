# AppWorld interface research

## Domains, families, instances, and coverage

A **domain** here means a business application, such as Spotify (music) or Venmo
(payments). A **task family** is a reusable task generator: the prefix in
`e7a10f8_1`. An **instance** is one concrete task/world produced by that family:
`_1`, `_2`, or `_3`, with different parameters and application state. In the
installed train/dev data every family has three instances. A family may require
several apps, so domain counts can overlap; they are not a strict tree.

For example: Music → playlist-duration family `e7a10f8` → three concrete
instances. Payments → contact-group totals `d0b1f43` → three instances requiring
both Venmo and Phone. AppWorld's `required_apps.json` metadata is the basis for
this inventory, not keyword matching against task instructions.

### Full business-domain list

AppWorld exposes nine business apps. Supervisor and API Docs are shared task
submission/credential/discovery helpers; Admin is internal, not an agent domain.
The family counts below are for the installed **train + dev** data only. A zero
means no family in these two splits; it does not mean the app has no benchmark
tasks in other splits. Held-out task contents and solutions were not inspected.

| Domain             | App         | Train/dev families involving it | Current adapter scope                                                         |
| ------------------ | ----------- | ------------------------------: | ----------------------------------------------------------------------------- |
| Music              | Spotify     |                              26 | Catalog, personal collections/state, recommendations, player, selected writes |
| Payments           | Venmo       |                              14 | Own transactions, date/direction aggregation, likes and comments              |
| Phone and contacts | Phone       |                              16 | Email contacts and owner-scoped relationship groups only                      |
| Files              | File System |                               7 | Not implemented                                                               |
| Notes              | Simple Note |                               5 | Not implemented                                                               |
| Shopping           | Amazon      |                               0 | Not implemented                                                               |
| Email              | Gmail       |                               0 | Not implemented                                                               |
| Shared expenses    | Splitwise   |                               0 | Not implemented                                                               |
| Task management    | Todoist     |                               0 | Not implemented                                                               |

### Implemented task-family scope

The selected scope is **27 families / 81 instances**: the original four families
(12 instances), plus **23 additional families / 69 instances**. The addition is
exactly the remaining **22 Spotify-only families and one Venmo-only family**.
Existing Phone-backed payment families remain supported. No new cross-app family
was added in this expansion, even where Phone was already available.

“Implemented” means the adapter exposes the data and actions needed by the
family. It does **not** mean every model attempt passes. Offline preflight
checks read every acquired object/field through the SDK in all 69 new worlds; a
separate public-API smoke checks all 14 new Spotify mutations, readback,
membership creation/removal, rating updates, and receipt replay. These are
adapter checks, not agent scores. The original model results remain historical
evidence; new Haiku evaluation is documented in
[EXPANDED-FAMILIES.md](EXPANDED-FAMILIES.md).

| Family    | Capability                                                | Required apps | Split | Instances | Evaluation group     |
| --------- | --------------------------------------------------------- | ------------- | ----- | --------: | -------------------- |
| `23cf851` | Aggregate transaction likes by direction and date         | venmo         | dev   |         3 | Expanded Haiku batch |
| `396c5a2` | Queue artist songs selected by public play count          | spotify       | dev   |         3 | Expanded Haiku batch |
| `3ab5b8b` | Download liked songs from a selected collection           | spotify       | dev   |         3 | Expanded Haiku batch |
| `4ec8de5` | Count saved songs and album songs by release period       | spotify       | dev   |         3 | Expanded Haiku batch |
| `50e1ac9` | Rank personal-library songs by genre and play count       | spotify       | dev   |         3 | Expanded Haiku batch |
| `57c3486` | Like catalog songs by followed artists                    | spotify       | dev   |         3 | Expanded Haiku batch |
| `6171bbc` | Build playlists from per-collection song rankings         | spotify       | dev   |         3 | Expanded Haiku batch |
| `6bdbc26` | Inspect followers of the current song artist              | spotify       | dev   |         3 | Expanded Haiku batch |
| `b119b1f` | Navigate the player queue to an artist                    | spotify       | dev   |         3 | Expanded Haiku batch |
| `d4e9306` | Follow artists associated with liked songs and albums     | spotify       | dev   |         3 | Expanded Haiku batch |
| `fac291d` | Count distinct songs across personal music collections    | spotify       | dev   |         3 | Expanded Haiku batch |
| `07b42fd` | Follow catalog artists by genre and follower count        | spotify       | train |         3 | Expanded Haiku batch |
| `229360a` | Clean saved collections using likes and download state    | spotify       | train |         3 | Expanded Haiku batch |
| `27e1026` | Compare release dates across personal music collections   | spotify       | train |         3 | Expanded Haiku batch |
| `287e338` | Aggregate recommended songs by artist                     | spotify       | train |         3 | Expanded Haiku batch |
| `692c77d` | Rate songs using personal likes and library membership    | spotify       | train |         3 | Expanded Haiku batch |
| `82e2fac` | Song popularity across personal collections               | spotify       | train |         3 | Original             |
| `aa8502b` | Follow or unfollow artists using personally liked songs   | spotify       | train |         3 | Expanded Haiku batch |
| `afc0fce` | Comments and likes on selected payments                   | phone, venmo  | train |         3 | Original             |
| `b7a9ee9` | Follow artists selected by playlist song genre            | spotify       | train |         3 | Expanded Haiku batch |
| `c901732` | Play songs selected from album or playlist statistics     | spotify       | train |         3 | Expanded Haiku batch |
| `ccb4494` | Like songs through the current queue position             | spotify       | train |         3 | Expanded Haiku batch |
| `ce359b5` | Remove songs from libraries and playlists by release date | spotify       | train |         3 | Expanded Haiku batch |
| `d0b1f43` | Payments by contact group and direction                   | phone, venmo  | train |         3 | Original             |
| `e3d6c94` | Create playlists from filtered recommendations            | spotify       | train |         3 | Expanded Haiku batch |
| `e7a10f8` | Playlist duration comparisons                             | spotify       | train |         3 | Original             |
| `e85d92a` | Compare public song popularity for an artist              | spotify       | train |         3 | Expanded Haiku batch |

### Available families outside the implemented scope

There are **13 further Spotify/Venmo families** requiring additional apps: two
music families (File System or Simple Note), and eleven payments families (nine
Phone-only companions, one Phone + File System, one Phone + Simple Note). These
are excluded from the current expansion. Nine other train/dev families belong to
the remaining represented domains. The complete inventory follows; capability
labels are summaries, not copied task instructions or solutions.

| Family    | Capability                                      | Required apps             | Split | Instances |
| --------- | ----------------------------------------------- | ------------------------- | ----- | --------: |
| `0d8a4ee` | Contact payment-account discovery and messaging | phone, venmo              | dev   |         3 |
| `37a8675` | Pay a contact identified by phone               | phone, venmo              | dev   |         3 |
| `383cbac` | Aggregate contact-group social-feed payments    | phone, venmo              | dev   |         3 |
| `4fab96f` | Remind contacts about payment requests          | phone, venmo              | dev   |         3 |
| `530b157` | Payments and message confirmation               | phone, venmo              | dev   |         3 |
| `68ee2c9` | Rename and move files                           | file_system               | dev   |         3 |
| `6c2c621` | Export notes to files                           | file_system, simple_note  | dev   |         3 |
| `df61dc5` | Like contact-group payments                     | phone, venmo              | dev   |         3 |
| `22cc237` | Expense requests from notes                     | phone, simple_note, venmo | train |         3 |
| `29caf6f` | Message replies from notes                      | phone, simple_note        | train |         3 |
| `2a163ab` | Contact-group activity in social feed           | phone, venmo              | train |         3 |
| `302c169` | Manage alarms                                   | phone                     | train |         3 |
| `34d9492` | Organize files by metadata                      | file_system               | train |         3 |
| `3c13f5a` | Payment requests from bill files                | file_system, phone, venmo | train |         3 |
| `60d0b5b` | Refund a contact payment                        | phone, venmo              | train |         3 |
| `6104387` | Music export and account lifecycle              | file_system, spotify      | train |         3 |
| `6ea6792` | Approve contact-group payment requests          | phone, venmo              | train |         3 |
| `76f2c72` | Aggregate bill files                            | file_system               | train |         3 |
| `771d8fc` | Delete unwanted messages                        | phone                     | train |         3 |
| `7d7fbf6` | Archive directories                             | file_system               | train |         3 |
| `b0a8eae` | Playlist selection using notes                  | simple_note, spotify      | train |         3 |
| `cf6abd2` | Update note contents                            | simple_note               | train |         3 |

### Interface contracts and limits

The SDK and snapshot-TypeScript conditions share the same fixed acquisition in
every episode: Spotify's public song/album/artist catalogs; personal saved
songs, saved albums and playlists; likes, downloads, follows, recommendations
and queue; plus Phone contacts and own Venmo transactions. Raw Python discovers
and calls original APIs itself. No acquisition routing depends on task IDs or
answers. This remains a comparison of complete interfaces, including acquisition
and normalization differences; it does not isolate SDK syntax alone.

- `Song.query()` and `Album.query()` now cover the public catalog. Personal
  membership is explicit: `MusicLibrary.savedSongs`, `.savedAlbums`, and
  `.allSongs` (the deduplicated union of song/album/playlist libraries).
- `SongState` separates personal `liked`/`downloaded` from public average
  `rating`; `Song.likeCount` and `playCount` are public totals. Artists have
  public follower counts and a personal `following` flag. `Song.artists` and
  `Album.artists` expose canonical artist references.
- `Recommendation` preserves recommendation occurrences. `QueueEntry` preserves
  provider positions and current/playing flags. `Album.songs` and
  `Playlist.songs` retain separate memberships. A downloaded album means every
  album song is downloaded; it is not inferred from a saved-album membership.
- Spotify actions: `rateSong`, `likeSong`, `downloadSong`, `followArtist`,
  `unfollowArtist`, `removeSavedSong`, `removeSavedAlbum`, `removePlaylistSong`,
  `createPlaylist`, `addPlaylistSong`, `playSong`, `queueSong`, `nextSong`, and
  `previousSong`. `refreshMusic` performs readback without a mutation.
  State-setting actions succeed without another write when the requested state
  already exists.
- Mutations retain a durable provider result before readback. Confirmed writes
  can return `refreshState: pending`; music records then carry
  `syncState: pending` and may be stale. Call `refreshMusic` with a fresh key
  before using them. An uncertain write must never be retried with a new key.
  Journals are episode/account-local; see
  [WRITE_RECOVERY.md](WRITE_RECOVERY.md).
- Each music mutation refreshes the full music snapshot through public APIs;
  this is deliberately simple research infrastructure, not an incremental sync
  design. Creation is adopted and removed memberships are refreshed as deleted.
- Venmo social feeds, sending money, payment requests and reminders are not
  implemented. Phone support is contacts only. App availability never implies
  all its APIs or task families are covered.

```js
const library = (await relate.objects.MusicLibrary.query()).data[0];
for await (const song of relate.objects.MusicLibrary.traverse.allSongs(
  library.id,
)) {
  console.log(song.data.title);
}
const receipt = await relate.actions.createPlaylist({
  input: { title: 'My selection' },
  idempotencyKey: 'create-selection',
});
// A source ID is not a canonical reference: query the newly adopted playlist.
const playlist = (
  await relate.objects.Playlist.query({
    where: { sourceId: receipt.output.sourceId },
  })
).data[0];
```

The executable registry is [task_catalog.py](task_catalog.py); the checked
train/dev inventory is
[task-family-inventory.json](evidence/task-family-inventory.json). Validate it
against a local installation with:

```sh
dev/research/appworld/.venv/bin/python dev/research/appworld/task_catalog.py
dev/research/appworld/.venv/bin/python dev/research/appworld/test/expanded_preflight.py
```

## Current main on two models

[TWO-MODEL.md](TWO-MODEL.md) documents the single-pass evaluation of the
original twelve selected tasks on GPT-5.4 Nano and Claude Haiku 5.5 through raw
Python, raw TypeScript, Relate SDK, and snapshot TypeScript. All 96 attempts
retain complete trajectories. The local results explorer supports task, family,
model, interface, and outcome filters, per-turn inspection, official scoring,
and original-file downloads.

## Explainer evaluation after the main fixes

[EXPLAINER-RESULTS.md](EXPLAINER-RESULTS.md) reports 336 scored episodes across
screening, fresh confirmation and preselected holdout. Local datetime is the
only SDK candidate that passed every phase gate (24/36 versus 20/36 paired
controls). The snapshot TypeScript control also qualifies as research evidence;
traversal filters failed holdout and the other candidates failed screening.
Recorded model cost was $2.97, with no infrastructure failures or missing usage.

[EXPLAINER-STATUS.md](EXPLAINER-STATUS.md) preserves the seven independent SDK
branches, frozen build identities, offline validation and reproduction commands.
The promoted datetime implementation is
[PR #26](https://github.com/relatehq/relate/pull/26), integrated separately onto
newer main; the evaluation branches remain frozen.

## Earlier independent ergonomics experiments

[ERGONOMICS.md](ERGONOMICS.md) compares SDK receipt discovery, request error
messages, query-consumption examples and two graph-description changes, one at a
time. Fresh controls and a predeclared confirmation rule determine which SDK
fixes qualify for separate PRs into main. No SDK implementation is stored in
this research branch. Protocol: [ERGONOMICS-PLAN.md](ERGONOMICS-PLAN.md).

Only the contact-description change confirmed: 18/24 versus 16/24 successes,
with similar turns and 6.5% fewer input tokens. Its three description strings
are retained in `sdk-graph.mjs`. The other graph variant remains an experiment;
none of the SDK spikes qualified for a PR. All 120 new episodes are retained.

## Previous main-query and expanded-task experiment

[QUERIES.md](QUERIES.md) reports six tasks, three methods and two repeats after
merging main's scalar predicates and shared consumer implementation. It retains
the improved graph property descriptions and unchanged prompts. Results for the
original three tasks are separated from the three additions. Protocol:
[QUERIES-PLAN.md](QUERIES-PLAN.md).

## Previous contact-graph experiment

[GRAPH-SHAPE.md](GRAPH-SHAPE.md) compares explicit owner-scoped contact
relationships, Person.email and field descriptions with the preceding graph.
Prompts and SDK packages remain unchanged. The same 18-episode, three-method,
28-turn protocol is frozen in [GRAPH-SHAPE-PLAN.md](GRAPH-SHAPE-PLAN.md).

Subsequent model documentation clarifies transaction occurrence time, payment
amount units, and song duration, release date, counts and artist encoding at the
property level. AppWorld deliberately uses timezone-free datetimes; the graph
preserves these strings without assigning UTC. These description edits are
evaluated with the main query update in [QUERIES.md](QUERIES.md). The older
contact-graph report and its frozen execution sources remain unchanged.

## Previous completion-prompt experiment

Static notes are retired from future comparisons. The current methods are raw
Python, raw TypeScript and Relate SDK. [COMPLETION.md](COMPLETION.md) reports
the 28-turn rerun with an explicit no-answer completion example once in each
system prompt. See [COMPLETION-PLAN.md](COMPLETION-PLAN.md) for the frozen plan.
Historical static-note results remain available for reference.

## Previous turn-budget comparison

That run doubles the turn limit from 14 to 28 while retaining identical prompts,
execution code, nano, three tasks and all four methods. Overall official success
is 2/24 → 6/24; 4 new successes finished after turn 14. These are fresh
stochastic runs, not continuations of matched prefixes.

Read [WRITE-BUDGET.md](WRITE-BUDGET.md) for the full comparison, per-case
metrics, concrete failure analysis and next proposals. The explorer retains both
budgets and links matching task/method/repeat cases. No prompt, REPL,
acquisition, action implementation or Relate package change was made for this
experiment.

## Previous 14-turn write-action pilot

Main `5a0af21` is merged. The first write increment adds two research-authored
Relate actions for Venmo likes and comments, with source readback and refreshed
SDK observations. All four methods remain; no original APIs or credentials are
exposed to the SDK agent.

Read [WRITE-PILOT.md](WRITE-PILOT.md) for the 24-episode results, action
contracts, source/receipt guarantees, example trajectories, all timing/token
measurements, and proposed next tests. All methods scored 0/4 on write tasks.
Relate passed 2/2 read controls; one write failure nevertheless passed all
world-state checks and failed only answer submission. This is a development
diagnostic, not a held-out benchmark score. The previous study below is
preserved separately.

## Previous four-way read comparison

The preceding read study uses uniform prompts adapted from AppWorld, nano, six
training instances and three repeats per condition (72 episodes). Read
[TS-COMPARISON.md](TS-COMPARISON.md) for results and reproduction,
[PROMPT-PROVENANCE.md](PROMPT-PROVENANCE.md) for the exact upstream source and
adaptations, and [TS-COMPARISON-PLAN.md](TS-COMPARISON-PLAN.md) for the plan
frozen before model execution.

| Condition | Interpreter       | Agent's application-data interface                        |
| --------- | ----------------- | --------------------------------------------------------- |
| `raw`     | Python            | Original AppWorld APIs                                    |
| `static`  | Python            | Original APIs plus unchanged semantic notes               |
| `raw_ts`  | TypeScript / Node | Original APIs via an asynchronous named-argument proxy    |
| `sdk`     | TypeScript / Node | Actual Relate SDK, with no original APIs or source tokens |

The two Node conditions share the same REPL, transpilation, permissions and
`completeTask({answer, status})` environment capability. The raw TS proxy
preserves original operations, JSON responses and manual pagination. It receives
no graph or acquired snapshot. Only the SDK condition gets the fixed,
pre-acquired music-and-payments graph. The model discovers it through the public
SDK; the prompt contains no domain schema or relationship names.

```ts
// Raw TS: original API, original named arguments and original JSON response.
console.log(
  await apis.api_docs.show_api_doc({
    app_name: 'spotify',
    api_name: 'show_playlist_library',
  }),
);

// SDK-only: discover the real consumer's capabilities.
console.log(await relate.describe());

// Both Node conditions submit to the benchmark through the environment.
await completeTask({ answer: result });
```

These are different conditions, not globals coexisting in one agent environment.
`completeTask` is not part of the Relate SDK. The host rejects generic API
events from the SDK worker. Completion instructions appear once in every system
prompt; there are no per-turn reminders.

## Recorded studies

The previous nano rerun used four training tasks and mixed SDK/API access. Read
[SDK-NANO-RERUN.md](SDK-NANO-RERUN.md) for its historical results. Its SDK
scores must not be interpreted as SDK-only scores or pooled with the new run.

The preceding study compares Python AppWorld API agents with TypeScript agents
using the actual Relate SDK. Read [SDK-STUDY.md](SDK-STUDY.md) for its protocol,
results and reproduction command. SDK agents discover the graph through
`describe()`, use public `query()`/`get()`/traversal, and receive compact
evidence by default. No `research()` interface is exposed to them.

The earlier local-model study is retained as historical evidence: semantic
notes, bulk acquisition, graph traversal and experimental evidence presentation.
Read [FINDINGS.md](FINDINGS.md) for those results, [PLAN.md](PLAN.md) for the
original boundaries and [BENCHMARKS.md](BENCHMARKS.md) for alternatives.

This is an **AppWorld-based interface experiment**, not a leaderboard
submission. Predefined source adapters change the permitted tool interface.
Train/development results are exploratory; test-normal and test-challenge are
not used.

## Reproduce the original Ollama study

For the direct-SDK study, use the separate commands in
[SDK-STUDY.md](SDK-STUDY.md) and Node 26 (the REPL uses its filesystem and
network permission controls). The original recorded runs used commit `50b83f1`;
use that revision or the archived source snapshots for historical reproduction.
The compatibility adapter now explicitly requests full evidence before its old
projection so current compact-by-default packages do not silently change the old
arm labels.

From the repository root, run `pnpm install` and `pnpm build`. Then:

```sh
cd dev/research/appworld
uv venv --python 3.11.6 .venv
uv pip sync --python .venv/bin/python requirements.lock
.venv/bin/appworld install
.venv/bin/appworld download data --root .local/world
ollama list
```

Use an already installed local model. The runner calls only
`http://localhost:11434/api/chat`; it has no cloud-model fallback.

```sh
.venv/bin/python runner.py \
  --model qwen3.6:27b --think false --bootstrap \
  --run reproduction-v1 \
  --tasks e7a10f8_1 d0b1f43_1 \
  --conditions raw static flat full compact \
  --seeds 11 --steps 14 --context 16384
```

The separate, post-hoc documentation follow-up used the same model and budgets:

```sh
.venv/bin/python runner.py \
  --model qwen3.6:27b --bootstrap --clarify-interface \
  --run reproduction-docs-v2 --tasks d0b1f43_1 \
  --conditions flat compact --seeds 11 --steps 14 --context 16384
```

`--clarify-interface` documents response envelopes and canonical reference IDs
with an example, and removes unavailable traversal docs from the flat condition.
It changes prompts only. Omit it to reproduce the original conditions. This
follow-up was selected after reading primary traces; it is not held-out
evidence.

A run name is immutable. Choose a new name for repetitions. Each run saves its
configuration, code snapshots and hashes; each episode saves its trajectory,
original evaluator output, API calls and metrics. Model seeds are not a
guarantee of bitwise determinism across Ollama versions or hardware. Canonical
graph IDs are regenerated per world, so their literal strings also differ.

## Original Ollama conditions (historical)

| Condition | Agent access                                                          |
| --------- | --------------------------------------------------------------------- |
| `raw`     | Original APIs and persistent Python execution                         |
| `static`  | Original APIs plus relationship/field interpretation notes            |
| `flat`    | The notes plus a normalized bulk snapshot, list/get and Python joins  |
| `full`    | The same acquisition plus Relate get/traverse and full field evidence |
| `compact` | The same Relate operations with compact evidence                      |

The bulk control shares snapshot construction and identifier assignment with the
graph conditions; it reads normalized records directly rather than invoking
Relate reads/traversal. It controls for acquisition and normalization, not all
possible semantic-model effects. Only the raw condition is a no-model baseline.

The primary study uses `--bootstrap`: every condition starts with the same
host-authenticated Spotify, phone and Venmo sessions. Four setup API calls are
counted separately. This focuses the comparison on data access after login. It
also adds explicit interpreter initialization instructions equally to all
conditions.

All conditions retain original write APIs. There is no implementation of Relate
MCP, source writes, query planning or aggregation here. An experimental
`research` Python function bridges to a task-local Node process calling
`@relate/node`.

Two snapshot domains are available:

- Music: all playlist-library pages, unique songs and membership junctions.
- Payments: all email-bearing phone contacts and the user's Venmo transactions,
  joined by exact email, with directional sender/receiver references.

Original APIs acquire all data. The graph never reads AppWorld's private
database or evaluator. Snapshots are invalidated after original API writes. This
deliberately conservative mechanism is not a production freshness
implementation. Field provenance describes the application snapshot, not a live
provider authorization.

`list` is an adapter-owned enumeration of adopted records. `traverse` runs
through Relate's actual runtime and consumes continuation pages. The adapter
combines page data and reports exhaustion; it does not preserve every original
page-level metadata field. Neither is evidence that Relate has a general
source-backed query/list interface.

## Original Ollama validation and diagnostics

```sh
node --test test/*.test.mjs
.venv/bin/python -m unittest discover -s test -p 'test_*.py' -v
.venv/bin/python probe_adapter.py
node measure.mjs
.venv/bin/python summarize.py reproduction-v1 --output .local/reproduction.json
```

The integration probe uses a training world, explicit scripted login and public
reads. It is a deterministic adapter check, **not an agent success result**.
`measure.mjs` uses synthetic records to isolate response-size scaling and
paging; it is also separate from task scores.

The compact renderer keeps completeness/degradation and exceptional field
status, including forbidden, unavailable and stale values. It omits repetitive
positive field evidence. It is an experimental projection, not a complete
production contract for warnings, ordering, durability or provenance. Tests
check value equivalence, retained exceptions, identity separation, many-to-many
links, directionality, pagination and world reset.

## Evidence handling

AppWorld protects task data and trajectories against unintended redistribution
into training corpora. Raw data and traces stay under ignored `.local/`; the
Python environment stays under ignored `.venv/`. An encrypted evidence bundle
can be created/restored using AppWorld's own format:

```sh
.venv/bin/python archive.py pack
.venv/bin/python archive.py unpack
```

The encryption follows AppWorld's distribution convention; it is not intended as
secret storage. Only simulated application credentials occur in these runs.
Public aggregate evidence must omit task instructions, answers and individual
records.

## Limits

- Tiny task samples cannot establish general uplift or statistical significance.
- Samples used for iteration are not held-out test results.
- Provider/runtime errors are separate from task failures.
- The model can use Python to process large responses without printing them;
  response bytes and visible context are separate metrics.
- Prompt-token totals sum the prompt count reported at every turn, including
  repeated history; they are not unique-token counts or cloud billing estimates.
- API calls inside acquisition count toward source-call totals. Snapshot-store
  reads and agent steps are distinct from source API calls.
- Permissions, live source denial, concurrent updates and external-action retry
  safety are outside this benchmark's evaluated claim.

Sources: [AppWorld](https://github.com/StonyBrookNLP/appworld),
[EvoOntology](https://arxiv.org/abs/2609.15779),
[Ollama chat API](https://docs.ollama.com/api/chat).

### Retained request accounting

The SDK runner journals each attempted model request in local `requests.json`
and saves each returned response and its usage in `steps.json` before execution.
Each step records whether execution is pending, finished, or failed. Generated
token limits are clamped to the episode's remaining allowance before each call.

Ergonomics reports and the local explorer retain incomplete arms, including
episodes with saved responses but no final result. Arm-level spending and
request counts cover all retained attempts; comparison metrics cover finished
episodes. Only an exact set of 12 expected SDK results without infrastructure
failures is eligible for comparison, and both candidate and control must
qualify. Requests without retained usage are counted separately; the budget
validator rejects unknown usage instead of treating it as free.

Run the synthetic accounting regressions without paid model calls:

```sh
dev/research/appworld/.venv/bin/python -m unittest discover -s dev/research/appworld/test -p 'test_accounting.py' -v
```

### Explicit Spotify library membership (previous snapshot scope)

This paragraph describes the earlier saved-library extension. The current
expanded catalog and membership contracts are documented at the top of this
README.

SDK and snapshot acquisition now exhaust the playlist, saved-song, and
saved-album library APIs, and fetch every distinct song in those collections.
`MusicLibrary.savedSongs` selects the saved song library;
`MusicLibrary.savedAlbums` followed by `Album.songs` selects songs in saved
albums (deduplicate song IDs when combining albums). `Playlist.songs` retains
its separate membership. `Song.query()` is the union, not a personal library.
`Song.albumId` is nullable and denotes an original album association only.
Library ownership references the supervisor's canonical `Person`. Historical
runs and the legacy Python acquisition path are unchanged.
