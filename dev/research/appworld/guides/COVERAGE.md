# Coverage and current adapter contracts

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
[EXPANDED-FAMILIES.md](../EXPANDED-FAMILIES.md).

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
  `rating`. `personalRating` is the account’s own review rating, or null when
  unrated (added after the frozen Haiku batch); `Song.likeCount` and `playCount`
  are public totals. Artists have public follower counts and a personal
  `following` flag. `Song.artists` and `Album.artists` expose canonical artist
  references.
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
  [WRITE_RECOVERY.md](../WRITE_RECOVERY.md).
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

The executable registry is [task_catalog.py](../task_catalog.py); the checked
train/dev inventory is
[task-family-inventory.json](../evidence/task-family-inventory.json). Validate
it against a local installation with:

```sh
dev/research/appworld/.venv/bin/python dev/research/appworld/task_catalog.py
dev/research/appworld/.venv/bin/python dev/research/appworld/test/expanded_preflight.py
```
