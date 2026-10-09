import { z } from 'zod';
import {
  defineAccess,
  defineGraph,
  defineObject,
  defineRelationship,
  defineSource,
  from,
  objectId,
  reference,
  source,
} from 'relate';

/** Fresh definitions for many-to-many authoring and execution tests. */
export function createPlaylistGraph(restrictedReference?: 'playlist' | 'song') {
  const access = defineAccess({
    roles: ['reader', 'editor'],
    fieldGroups: ['ordinary', 'links'],
    claims: { visible: z.boolean() },
  });
  const playlists = defineSource({
    id: 'music.playlists',
    idField: 'id',
    schema: z.object({
      id: z.string(),
      name: z.string(),
      visible: z.boolean(),
    }),
  });
  const songs = defineSource({
    id: 'music.songs',
    idField: 'id',
    schema: z.object({
      id: z.string(),
      title: z.string(),
      visible: z.boolean(),
    }),
  });
  const memberships = defineSource({
    id: 'music.memberships',
    idField: 'id',
    schema: z.object({
      id: z.string(),
      playlist: z.string(),
      song: z.string(),
      position: z.number(),
      visible: z.boolean(),
    }),
  });
  const Playlist = defineObject({
    id: 'playlist',
    membership: source(playlists),
    properties: {
      id: objectId({ id: 'playlist.id' }),
      name: from(playlists.fields.name, { id: 'playlist.name' }),
      visible: from(playlists.fields.visible, { id: 'playlist.visible' }),
    },
  });
  const Song = defineObject({
    id: 'song',
    membership: source(songs),
    properties: {
      id: objectId({ id: 'song.id' }),
      title: from(songs.fields.title, { id: 'song.title' }),
      visible: from(songs.fields.visible, { id: 'song.visible' }),
    },
  });
  const Membership = defineObject({
    id: 'membership',
    membership: source(memberships),
    properties: {
      id: objectId({ id: 'membership.id' }),
      playlist: reference(Playlist, {
        id: 'membership.playlist',
        from: memberships.fields.playlist,
        ...(restrictedReference === 'playlist'
          ? { access: access.groups.links }
          : {}),
      }),
      song: reference(Song, {
        id: 'membership.song',
        from: memberships.fields.song,
        ...(restrictedReference === 'song'
          ? { access: access.groups.links }
          : {}),
      }),
      position: from(memberships.fields.position, {
        id: 'membership.position',
      }),
      visible: from(memberships.fields.visible, { id: 'membership.visible' }),
    },
  });
  const PlaylistSongs = defineRelationship({
    id: 'playlist.songs',
    forward: 'songs',
    reverse: 'playlists',
    through: {
      from: Membership.properties.playlist,
      to: Membership.properties.song,
    },
  });
  const PlaylistEntries = defineRelationship({
    id: 'playlist.entries',
    forward: 'entries',
    reverse: 'playlist',
    via: Membership.properties.playlist,
  });
  const policy = {
    read: {
      gate: access.role('reader'),
      where: { visible: { eq: access.claims.visible } },
      evidenceMaxAgeMs: 10_000,
    },
    groups: { links: access.role('editor') },
  };
  const graph = defineGraph({
    id: 'music',
    access,
    objects: { Playlist, Song, Membership },
    relationships: { PlaylistSongs, PlaylistEntries },
    policies: { Playlist: policy, Song: policy, Membership: policy },
  });
  const reader = { id: 'reader', roles: ['reader'], claims: { visible: true } };

  return {
    graph,
    access,
    Playlist,
    Song,
    Membership,
    PlaylistSongs,
    playlists,
    songs,
    memberships,
    reader,
  };
}
