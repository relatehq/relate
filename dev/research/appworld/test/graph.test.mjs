import assert from 'node:assert/strict';
import test from 'node:test';
import { compact, createSnapshot } from '../graph.mjs';

function rows() {
  return {
    Playlist: [
      { sourceId: '1', title: 'First' },
      { sourceId: '2', title: 'Second' },
    ],
    Song: [
      {
        sourceId: '1',
        title: 'Shared',
        albumId: '7',
        duration: 180,
        genre: 'classical',
        releaseDate: '2020-01-01',
        likeCount: 8,
        playCount: 20,
        artistsJson: '[]',
      },
    ],
    Membership: [
      { sourceId: '1:1', playlist: '1', song: '1' },
      { sourceId: '2:1', playlist: '2', song: '1' },
    ],
  };
}

test('same source ID in different types remains distinct; junctions preserve both memberships', async () => {
  const snapshot = await createSnapshot(rows());

  try {
    assert.notEqual(snapshot.ids.Playlist.get('1'), snapshot.ids.Song.get('1'));
    const members = await snapshot.execute({
      op: 'traverse',
      kind: 'Song',
      id: '1',
      relation: 'memberships',
      condition: 'full',
    });

    assert.equal(members.result.data.length, 2);
    const target = await snapshot.execute({
      op: 'traverse',
      kind: 'Membership',
      id: '2:1',
      relation: 'song',
      condition: 'full',
    });

    assert.equal(target.result.data.sourceId, '1');
    assert.equal(target.result.data.title, 'Shared');
  } finally {
    await snapshot.close();
  }
});

test('flat and Relate return the same selected values; compact retains values', async () => {
  const snapshot = await createSnapshot(rows());

  try {
    for (const select of [undefined, ['sourceId', 'title', 'likeCount']]) {
      const flat = await snapshot.execute({
        op: 'list',
        kind: 'Song',
        condition: 'flat',
        select,
      });
      const full = await snapshot.execute({
        op: 'list',
        kind: 'Song',
        condition: 'full',
        select,
      });
      const concise = await snapshot.execute({
        op: 'list',
        kind: 'Song',
        condition: 'compact',
        select,
      });

      assert.deepEqual(
        flat.result.data.map((r) => r.data),
        full.result.data.map((r) => r.data),
      );
      assert.deepEqual(
        concise.result.data.map((r) => r.data),
        full.result.data.map((r) => r.data),
      );
      assert.equal(concise.result.meta.exhausted, true);
    }
  } finally {
    await snapshot.close();
  }
});

test('compact rendering preserves withheld and stale field evidence', () => {
  const result = compact({
    data: { name: 'A' },
    meta: {
      completeness: 'partial',
      degraded: true,
      fields: {
        name: { status: 'available', freshness: 'fresh' },
        secret: { status: 'forbidden' },
        old: { status: 'available', freshness: 'stale' },
        offline: { status: 'unavailable' },
      },
    },
  });

  assert.equal(result.meta.completeness, 'partial');
  assert.equal(result.meta.degraded, true);
  assert.deepEqual(Object.keys(result.meta.fields), [
    'secret',
    'old',
    'offline',
  ]);
});

test('a fresh snapshot never retains records from an earlier world', async () => {
  const first = await createSnapshot(rows());

  await first.close();
  const second = await createSnapshot({
    Playlist: [],
    Song: [],
    Membership: [],
  });

  try {
    assert.deepEqual(
      (
        await second.execute({
          op: 'get',
          kind: 'Song',
          id: '1',
          condition: 'compact',
        })
      ).result,
      { status: 'not-found' },
    );
  } finally {
    await second.close();
  }
});

test('traversal consumes continuation pages beyond 100 memberships', async () => {
  const data = rows();

  data.Playlist = Array.from({ length: 105 }, (_, i) => ({
    sourceId: String(i),
    title: `Playlist ${i}`,
  }));
  data.Membership = data.Playlist.map((p) => ({
    sourceId: `${p.sourceId}:1`,
    playlist: p.sourceId,
    song: '1',
  }));
  const snapshot = await createSnapshot(data);

  try {
    const page = await snapshot.execute({
      op: 'traverse',
      kind: 'Song',
      id: '1',
      relation: 'memberships',
      condition: 'compact',
      select: ['sourceId'],
    });

    assert.equal(page.result.data.length, 105);
    assert.equal(
      new Set(page.result.data.map((r) => r.data.sourceId)).size,
      105,
    );
    assert.equal(page.result.meta.exhausted, true);
  } finally {
    await snapshot.close();
  }
});

test('cross-source email identities retain transaction direction and API identifiers', async () => {
  const snapshot = await createSnapshot({
    Person: [
      { sourceId: 'self@example.test', name: 'Self', relationshipsJson: '[]' },
      {
        sourceId: 'roommate@example.test',
        name: 'Roommate',
        relationshipsJson: '["roommate"]',
      },
    ],
    Transaction: [
      {
        sourceId: '42',
        sender: 'self@example.test',
        receiver: 'roommate@example.test',
        amount: 12.5,
        description: 'Bill',
        createdAt: '2023-01-01',
        likeCount: 1,
      },
    ],
  });

  try {
    const sent = await snapshot.execute({
      op: 'traverse',
      kind: 'Person',
      id: 'self@example.test',
      relation: 'sentTransactions',
      condition: 'compact',
    });

    assert.equal(sent.result.data.length, 1);
    assert.equal(sent.result.data[0].data.sourceId, '42');
    const received = await snapshot.execute({
      op: 'traverse',
      kind: 'Person',
      id: 'self@example.test',
      relation: 'receivedTransactions',
      condition: 'compact',
    });

    assert.equal(received.result.data.length, 0);
    const receiver = await snapshot.execute({
      op: 'traverse',
      kind: 'Transaction',
      id: '42',
      relation: 'receiver',
      condition: 'compact',
    });

    assert.equal(receiver.result.data.sourceId, 'roommate@example.test');
  } finally {
    await snapshot.close();
  }
});

test('a missing domain is not represented as an empty covered collection', async () => {
  const snapshot = await createSnapshot({ Person: [], Transaction: [] });

  try {
    await assert.rejects(
      () =>
        snapshot.execute({ op: 'list', kind: 'Song', condition: 'compact' }),
      /outside loaded snapshot coverage/,
    );
  } finally {
    await snapshot.close();
  }
});
