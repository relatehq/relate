import assert from 'node:assert/strict';
import test from 'node:test';
import { createRuntime } from '@relate/node';
import { connect } from 'relate';
import { model } from '../graph.mjs';

test('runtime traversal exhaustion describes adopted records, not undiscovered source rows', async () => {
  const { graph, sources, objects } = model();
  const backing = {
    Playlist: { p: { sourceId: 'p', title: 'Playlist' } },
    Song: {
      s: {
        sourceId: 's',
        title: 'Song',
        albumId: 'a',
        duration: 5,
        genre: 'test',
        releaseDate: '2020-01-01',
        likeCount: 1,
        playCount: 2,
        artistsJson: '[]',
      },
    },
    Membership: { m: { sourceId: 'm', playlist: 'p', song: 's' } },
    Person: {},
    Transaction: {},
  };
  const runtime = createRuntime({
    graph,
    connections: Object.entries(sources).map(([kind, source]) =>
      connect(source, {
        connectionId: kind,
        connector: {
          identity: 'application',
          async fetch(id) {
            const record = backing[kind][id];

            return record ? { state: 'present', record } : { state: 'deleted' };
          },
        },
      }),
    ),
  });

  try {
    const playlistId = await runtime.host.adopt(objects.Playlist, 'p');

    await runtime.host.adopt(objects.Song, 's');
    const consumer = runtime.as({
      id: 'reader',
      roles: ['reader'],
      claims: {},
    });
    const before =
      await consumer.objects.Playlist.traverse.memberships(playlistId);

    assert.equal(before.data.length, 0);
    assert.equal(before.meta.exhausted, true);
    // The source row already existed. Adoption makes it discoverable to traversal.
    await runtime.host.adopt(objects.Membership, 'm');
    const after =
      await consumer.objects.Playlist.traverse.memberships(playlistId);

    assert.equal(after.data.length, 1);
    assert.equal(after.meta.exhausted, true);
  } finally {
    await runtime.close();
  }
});
