import { z } from 'zod';
import { defineAction, defineRelationship, referenceInput } from 'relate';

export const musicTargets = {
  SongState: { song: 'Song' },
  AlbumState: { album: 'Album' },
  SongArtist: { song: 'Song', artist: 'Artist' },
  AlbumArtist: { album: 'Album', artist: 'Artist' },
  LibrarySong: { library: 'MusicLibrary', song: 'Song' },
  Recommendation: { library: 'MusicLibrary', song: 'Song' },
  QueueEntry: { library: 'MusicLibrary', song: 'Song' },
};

export const musicSchemas = {
  Artist: z.object({
    sourceId: z.string(),
    name: z.string(),
    genre: z.string(),
    followerCount: z.number(),
    following: z.boolean(),
  }),
  SongState: z.object({
    sourceId: z.string(),
    song: z.string(),
    rating: z
      .number()
      .describe(
        'Public average rating across reviewers; not the current account rating',
      ),
    personalRating: z
      .number()
      .nullable()
      .describe(
        'This account own review rating, or null when it has not reviewed the song. Use for conditions on an existing personal rating.',
      ),
    liked: z.boolean(),
    downloaded: z.boolean(),
  }),
  AlbumState: z.object({
    sourceId: z.string(),
    album: z.string(),
    liked: z.boolean(),
  }),
  SongArtist: z.object({
    sourceId: z.string(),
    song: z.string(),
    artist: z.string(),
  }),
  AlbumArtist: z.object({
    sourceId: z.string(),
    album: z.string(),
    artist: z.string(),
  }),
  LibrarySong: z.object({
    sourceId: z.string(),
    library: z.string(),
    song: z.string(),
  }),
  Recommendation: z.object({
    sourceId: z.string(),
    library: z.string(),
    song: z.string(),
    position: z.number(),
  }),
  QueueEntry: z.object({
    sourceId: z.string(),
    library: z.string(),
    song: z.string(),
    position: z.number(),
    isCurrent: z.boolean(),
    isPlaying: z.boolean(),
  }),
};

export const musicDescriptions = {
  Artist:
    'Public Spotify artist catalog. followerCount is public; following is whether this authenticated account follows the artist.',
  SongState:
    'One state row per catalog song: liked/downloaded are personal booleans for this account; rating is the public average song rating; personalRating is this account own rating or null when unrated. Use personalRating for conditions on an existing review. Join song to Song.',
  AlbumState:
    'Whether this authenticated account personally likes an album. Album download state is derived by checking downloaded on every SongState of its songs.',
  SongArtist:
    'Explicit association between a catalog song and its performing artist.',
  AlbumArtist: 'Explicit association between a catalog album and its artists.',
  LibrarySong:
    'Deduplicated union of saved songs, songs in saved albums, and songs in personal playlists. Catalog Song.query() includes songs outside these libraries.',
  Recommendation:
    'One personalized recommended song occurrence, in provider order. Count occurrences by artist for recommendation frequency.',
  QueueEntry:
    'A player queue entry with provider position (zero-based), song, isCurrent and isPlaying. Positions through the current entry represent songs played so far. An empty queue has no current entry. Navigation actions refresh this collection.',
};

export const musicActionTargets = {
  likeSong: { song: 'Song' },
  downloadSong: { song: 'Song' },
  rateSong: { song: 'Song' },
  followArtist: { artist: 'Artist' },
  unfollowArtist: { artist: 'Artist' },
  removeSavedSong: { song: 'Song' },
  removeSavedAlbum: { album: 'Album' },
  removePlaylistSong: { playlist: 'Playlist', song: 'Song' },
  addPlaylistSong: { playlist: 'Playlist', song: 'Song' },
  createPlaylist: {},
  playSong: { song: 'Song' },
  queueSong: { song: 'Song' },
  nextSong: {},
  previousSong: {},
  refreshMusic: {},
};

export function musicActions(objects, access) {
  const descriptions = {
    likeSong: 'Like a song for this account.',
    downloadSong: 'Download a song for this account.',
    rateSong:
      'Set this account’s song review rating (1–5); update an existing review without replacing its text, or create a review.',
    followArtist: 'Follow an artist.',
    unfollowArtist: 'Unfollow an artist.',
    removeSavedSong: 'Remove a song from the saved song library only.',
    removeSavedAlbum: 'Remove an album from the saved album library only.',
    removePlaylistSong: 'Remove a song from a playlist.',
    addPlaylistSong: 'Add a song to a playlist.',
    createPlaylist:
      'Create an empty private playlist. output.sourceId is the original playlist ID; query Playlist by sourceId to obtain its canonical reference for addPlaylistSong.',
    playSong: 'Play a selected song.',
    queueSong: 'Append a song to the player queue.',
    nextSong: 'Move to the next song in the queue.',
    previousSong: 'Move to the previous song in the queue.',
    refreshMusic:
      'Read the full music snapshot again, without a mutation. Use a fresh key after pending readback; this does not resolve an uncertain provider write.',
  };

  return Object.fromEntries(
    Object.entries(musicActionTargets).map(([name, targets]) => [
      name,
      defineAction({
        id: `spotify.${name}`,
        description:
          descriptions[name] +
          ' Confirmed mutations may return refreshState pending; use refreshMusic before relying on music reads. Never retry an uncertain mutation with a new key.',
        input: z.object({
          ...Object.fromEntries(
            Object.entries(targets).map(([field, kind]) => [
              field,
              referenceInput(objects[kind]),
            ]),
          ),
          ...(name === 'rateSong'
            ? {
                rating: z
                  .number()
                  .min(1)
                  .max(5)
                  .describe('Integer rating from 1 to 5'),
              }
            : {}),
          ...(name === 'createPlaylist' ? { title: z.string().min(1) } : {}),
        }),
        output: z.object({
          message: z.string(),
          sourceId: z.string().nullable(),
          operationId: z.string(),
          refreshState: z.string(),
        }),
        creates: [],
        policy: { execute: access.role('reader') },
      }),
    ]),
  );
}

export function musicRelationships(objects) {
  const through = (id, forward, reverse, kind, a, b) =>
    defineRelationship({
      id,
      forward,
      reverse,
      through: {
        from: objects[kind].properties[a],
        to: objects[kind].properties[b],
      },
    });
  const via = (id, forward, reverse, kind, field) =>
    defineRelationship({
      id,
      forward,
      reverse,
      via: objects[kind].properties[field],
    });

  return {
    CatalogSongArtists: through(
      'song.artists',
      'artists',
      'songs',
      'SongArtist',
      'song',
      'artist',
    ),
    CatalogAlbumArtists: through(
      'album.artists',
      'artists',
      'albums',
      'AlbumArtist',
      'album',
      'artist',
    ),
    PersonalLibrarySongs: through(
      'library.all-songs',
      'allSongs',
      'personalLibraries',
      'LibrarySong',
      'library',
      'song',
    ),
    SongStates: via(
      'song.account-state',
      'accountState',
      'song',
      'SongState',
      'song',
    ),
    AlbumStates: via(
      'album.account-state',
      'accountState',
      'album',
      'AlbumState',
      'album',
    ),
    LibraryRecommendations: via(
      'library.recommendations',
      'recommendations',
      'library',
      'Recommendation',
      'library',
    ),
    RecommendedSong: via(
      'song.recommendation-entries',
      'recommendationEntries',
      'song',
      'Recommendation',
      'song',
    ),
    LibraryQueue: via(
      'library.queue',
      'queue',
      'library',
      'QueueEntry',
      'library',
    ),
    QueuedSong: via(
      'song.queue-entries',
      'queueEntries',
      'song',
      'QueueEntry',
      'song',
    ),
  };
}
