import { createRuntime } from '@relate/node';
import { defineObject, defineRelationship, referenceInput } from 'relate';
import { createPlaylistGraph } from '../../../tests/support/playlist-graph.js';

const { graph, Playlist, Song, Membership, reader } = createPlaylistGraph();
const runtime = createRuntime({ graph, connections: [] });
const objects = runtime.as(reader).objects;
const playlist = referenceInput(Playlist).parse('playlist');
const song = referenceInput(Song).parse('song');
const page = await objects.Playlist.traverse.songs(playlist, {
  select: ['title'],
  limit: 1,
});
const title: string | undefined = page.data[0]?.data.title;
const reverse = await objects.Song.traverse.playlists(song, {
  select: ['name'],
  limit: 1,
  evidence: 'full',
});

reverse.data[0]?.meta.fields.name;
// @ts-expect-error membership properties are not destination properties
objects.Playlist.traverse.songs(playlist, { select: ['position'] });
// @ts-expect-error reverse selections belong to playlists
objects.Song.traverse.playlists(song, { select: ['title'] });
// @ts-expect-error root identity belongs to the playlist
objects.Playlist.traverse.songs(song);
// @ts-expect-error selection is retained
page.data[0]?.data.visible;

for await (const record of objects.Song.traverse.playlists(song, {
  select: ['name'],
})) {
  const name: string | undefined = record.data.name;

  void name;
}

const Other = defineObject({ ...Membership, id: 'other' });

// prettier-ignore
// @ts-expect-error through references must belong to the same object
defineRelationship({ id: 'bad', forward: 'songs', reverse: 'playlists', through: { from: Membership.properties.playlist, to: Other.properties.song } });
// prettier-ignore
// @ts-expect-error both fields must be references
defineRelationship({ id: 'bad', forward: 'songs', reverse: 'playlists', through: { from: Membership.properties.playlist, to: Membership.properties.position } });
// prettier-ignore
// @ts-expect-error through and via are mutually exclusive
defineRelationship({ id: 'bad', forward: 'songs', reverse: 'playlists', via: Membership.properties.playlist, through: { from: Membership.properties.playlist, to: Membership.properties.song } });
void title;
