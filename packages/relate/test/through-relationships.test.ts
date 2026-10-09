import { expect, it } from 'vitest';
import { defineObject, defineRelationship, reference } from 'relate';
import { compile } from 'relate/compiler';
import { validateManifest } from 'relate/model';
import { createPlaylistGraph } from '../../../tests/support/playlist-graph.js';

it('infers both endpoints and many cardinalities from immutable bound references', () => {
  const { graph, PlaylistSongs, Playlist, Song, Membership } =
    createPlaylistGraph();

  expect(PlaylistSongs.from).toBe(Playlist);
  expect(PlaylistSongs.to).toBe(Song);
  expect(Object.isFrozen(PlaylistSongs.through)).toBe(true);
  expect(compile(graph).manifest.relationships).toContainEqual({
    id: 'playlist.songs',
    fromObjectDefinitionId: Playlist.id,
    toObjectDefinitionId: Song.id,
    forward: { name: 'songs', cardinality: 'many' },
    reverse: { name: 'playlists', cardinality: 'many' },
    through: {
      objectDefinitionId: Membership.id,
      fromReferencePropertyDefinitionId: 'membership.playlist',
      toReferencePropertyDefinitionId: 'membership.song',
    },
  });
});

it('rejects unregistered, mismatched, duplicated and forged through references', () => {
  const { graph, PlaylistSongs, Playlist, Membership } = createPlaylistGraph();
  const other = defineObject({ ...Membership, id: 'other' });

  for (const relation of [
    { ...PlaylistSongs, from: { ...Playlist } },
    {
      ...PlaylistSongs,
      through: { ...PlaylistSongs.through, to: other.properties.song },
    },
    {
      ...PlaylistSongs,
      through: {
        ...PlaylistSongs.through,
        from: { ...Membership.properties.playlist },
      },
    },
    {
      ...PlaylistSongs,
      through: {
        from: Membership.properties.song,
        to: Membership.properties.song,
      },
    },
    { ...PlaylistSongs, via: Membership.properties.playlist },
  ])
    expect(() =>
      compile({
        ...graph,
        relationships: { relation },
      } as unknown as typeof graph),
    ).toThrow();

  const { Membership: _membership, ...objects } = graph.objects;

  expect(() => compile({ ...graph, objects })).toThrow('Unregistered');
});

it('validates portable through ownership, reference targets, cardinalities and names', () => {
  const { graph } = createPlaylistGraph();
  const original = compile(graph).manifest;

  for (const mutation of [
    {
      through: {
        objectDefinitionId: 'absent',
        fromReferencePropertyDefinitionId: 'membership.playlist',
        toReferencePropertyDefinitionId: 'membership.song',
      },
    },
    {
      through: {
        objectDefinitionId: 'membership',
        fromReferencePropertyDefinitionId: 'membership.position',
        toReferencePropertyDefinitionId: 'membership.song',
      },
    },
    {
      through: {
        objectDefinitionId: 'membership',
        fromReferencePropertyDefinitionId: 'membership.song',
        toReferencePropertyDefinitionId: 'membership.playlist',
      },
    },
    {
      through: {
        objectDefinitionId: 'membership',
        fromReferencePropertyDefinitionId: 'membership.song',
        toReferencePropertyDefinitionId: 'membership.song',
      },
    },
    { reverse: { name: 'playlists', cardinality: 'one' } },
    { forward: { name: 'entries', cardinality: 'many' } },
    { reverse: { name: '__proto__', cardinality: 'many' } },
    { referencePropertyDefinitionId: 'membership.song' },
  ]) {
    const manifest = structuredClone(original);

    Object.assign(
      manifest.relationships!.find((r) => r.id === 'playlist.songs')!,
      mutation,
    );
    expect(() => validateManifest(manifest)).toThrow();
  }
});

it('supports self relationships with two distinct references', () => {
  const { graph, Playlist, Membership, memberships } = createPlaylistGraph();
  const Link = defineObject({
    ...Membership,
    properties: {
      ...Membership.properties,
      song: reference(Playlist, {
        id: 'membership.song',
        from: memberships.fields.song,
      }),
    },
  });
  const relation = defineRelationship({
    id: 'related',
    forward: 'related',
    reverse: 'relatedBy',
    through: { from: Link.properties.playlist, to: Link.properties.song },
  });

  expect(() =>
    compile({
      ...graph,
      objects: { ...graph.objects, Membership: Link },
      relationships: { relation },
    }),
  ).not.toThrow();
});
