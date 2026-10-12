import assert from 'node:assert/strict';
import test from 'node:test';
import { createSdkSnapshot } from '../sdk-graph.mjs';

test('SDK discovery and canonical payment references support a direction-correct query', async () => {
  const snapshot = await createSdkSnapshot({
    Person: [
      { sourceId: 'me@example.test', email: 'me@example.test', name: 'Me' },
      {
        sourceId: 'roommate@example.test',
        name: 'Roommate',
        email: 'roommate@example.test',
      },
    ],
    Transaction: [
      {
        sourceId: '1',
        sender: 'me@example.test',
        receiver: 'roommate@example.test',
        amount: 25,
        description: 'Shared bill',
        createdAt: '2023-01-02T00:00:00',
        likeCount: 0,
        commentCount: 0,
      },
      {
        sourceId: '2',
        sender: 'roommate@example.test',
        receiver: 'me@example.test',
        amount: 10,
        description: 'Return',
        createdAt: '2023-01-03T00:00:00',
        likeCount: 0,
        commentCount: 0,
      },
    ],
  });

  try {
    const api = snapshot.consumer;
    const description = api.objects.Transaction.describe();

    assert.equal(
      description.operations.query.collectionScope,
      'graph-membership',
    );
    assert.equal(
      description.properties.find((p) => p.name === 'receiver').references
        .apiName,
      'Person',
    );
    const people = await api.objects.Person.query({
      where: { email: 'me@example.test' },
      select: ['name'],
    });
    const me = people.data[0];
    const sent = await api.objects.Transaction.query({
      where: { sender: me.id },
      select: ['amount', 'receiver'],
    });

    assert.deepEqual(
      sent.data.map((t) => t.data.amount),
      [25],
    );
    assert.equal(sent.data[0].meta.evidence, 'compact');
    assert.equal(sent.data[0].meta.fields, undefined);
    const receiver = await api.objects.Transaction.traverse.receiver(
      sent.data[0].id,
      { select: ['email'], evidence: 'full' },
    );

    assert.equal(receiver.data.email, 'roommate@example.test');
    assert.equal(receiver.meta.fields.email.status, 'available');
    const traversed = [];

    for await (const row of api.objects.Person.traverse.sentTransactions(
      me.id,
      { limit: 1, select: ['amount'] },
    ))
      traversed.push(row.data.amount);

    assert.deepEqual(traversed, [25]);
  } finally {
    await snapshot.close();
  }
});

test('source actions refresh observations and replay receipts without duplicate mutations', async () => {
  const transaction = {
    sourceId: '1',
    sender: 'me@test',
    receiver: 'me@test',
    amount: 10,
    description: 'Test',
    createdAt: '2023-01-01T00:00:00',
    likeCount: 0,
    commentCount: 0,
  };
  const calls = [];
  const snapshot = await createSdkSnapshot(
    {
      Person: [{ sourceId: 'me@test', name: 'Me', email: 'me@test' }],
      Transaction: [transaction],
    },
    async (request) => {
      calls.push(request);

      if (request.operation === 'likeTransaction') transaction.likeCount++;
      else transaction.commentCount++;

      return {
        mutationState: 'confirmed',
        refreshState: 'current',
        transaction: { ...transaction },
        output:
          request.operation === 'likeTransaction'
            ? { message: 'Liked' }
            : { message: 'Commented', commentId: '99' },
      };
    },
  );

  try {
    const api = snapshot.consumer;
    const id = (await api.objects.Transaction.query()).data[0].id;

    assert.deepEqual(
      api
        .describe()
        .actions.map((a) => a.apiName)
        .sort(),
      ['commentOnTransaction', 'likeTransaction', 'refreshTransaction'],
    );
    const request = {
      input: { transaction: id, comment: 'Thank you' },
      idempotencyKey: 'comment-1',
    };
    const receipt = await api.actions.commentOnTransaction(request);

    assert.equal(receipt.output.commentId, '99');
    assert.equal(receipt.output.refreshState, 'current');
    assert.equal(calls[0].operationId, receipt.output.operationId);
    const replay = await api.actions.commentOnTransaction(request);

    assert.equal(replay.output.commentId, '99');
    assert.equal(calls.length, 1);
    assert.equal((await api.objects.Transaction.get(id)).data.commentCount, 1);
    assert.equal(
      (await api.objects.Transaction.query()).data[0].data.commentCount,
      1,
    );
    await assert.rejects(
      api.actions.commentOnTransaction({
        ...request,
        input: { transaction: id, comment: 'different' },
      }),
    );
    await assert.rejects(
      api.actions.likeTransaction({
        input: { transaction: 'not-a-canonical-id' },
        idempotencyKey: 'bad',
      }),
    );
    assert.equal(calls.length, 1);
    await api.actions.likeTransaction({
      input: { transaction: id },
      idempotencyKey: 'like-1',
    });
    assert.equal((await api.objects.Transaction.get(id)).data.likeCount, 1);
    assert.equal(calls.length, 2);
  } finally {
    await snapshot.close();
  }
});

test('contact labels query by owner and kind, with canonical traversals in both directions', async () => {
  const snapshot = await createSdkSnapshot({
    Person: ['owner@test', 'other@test', 'contact@test'].map((email) => ({
      sourceId: email,
      email,
      name: email,
    })),
    ContactRelationship: [
      {
        sourceId: 'one',
        owner: 'owner@test',
        contact: 'contact@test',
        kind: 'friend',
      },
      {
        sourceId: 'two',
        owner: 'owner@test',
        contact: 'contact@test',
        kind: 'coworker',
      },
      {
        sourceId: 'three',
        owner: 'other@test',
        contact: 'contact@test',
        kind: 'friend',
      },
    ],
  });

  try {
    const { objects } = snapshot.consumer;
    const me = (await objects.Person.query({ where: { email: 'owner@test' } }))
      .data[0];
    const friends = [];

    for await (const row of objects.ContactRelationship.query({
      where: { owner: me.id, kind: 'friend' },
      limit: 1,
    }))
      friends.push(row);

    assert.equal(friends.length, 1);
    const friend = await objects.ContactRelationship.traverse.contact(
      friends[0].id,
    );

    assert.equal(friend.data.email, 'contact@test');
    const owner = await objects.ContactRelationship.traverse.owner(
      friends[0].id,
    );

    assert.equal(owner.id, me.id);
    const labels = [];

    for await (const row of objects.Person.traverse.contactRelationships(
      me.id,
      { limit: 1 },
    ))
      labels.push(row.data.kind);

    assert.deepEqual(labels.sort(), ['coworker', 'friend']);
    const incoming = [];

    for await (const row of objects.Person.traverse.labelsFromOthers(friend.id))
      incoming.push(row);

    assert.equal(incoming.length, 3);
    const description = objects.ContactRelationship.describe();

    assert.equal(
      description.properties.find((p) => p.name === 'owner').references.apiName,
      'Person',
    );
    assert.match(
      description.properties.find((p) => p.name === 'kind').description,
      /owner and kind/,
    );
    assert.ok(
      !objects.Person.describe().properties.some((p) =>
        ['sourceId', 'relationshipsJson'].includes(p.name),
      ),
    );
  } finally {
    await snapshot.close();
  }
});

for (const failure of ['bridge-response', 'invalid-readback']) {
  test(`confirmed write survives ${failure} failure`, async () => {
    const transaction = {
      sourceId: '1',
      sender: 'me@test',
      receiver: 'me@test',
      amount: 10,
      description: 'Test',
      createdAt: '2023-01-01T00:00:00',
      likeCount: 0,
      commentCount: 0,
    };
    const journal = new Map();
    const operationIds = [];
    let attempts = 0;
    let writes = 0;
    const snapshot = await createSdkSnapshot(
      {
        Person: [{ sourceId: 'me@test', name: 'Me', email: 'me@test' }],
        Transaction: [transaction],
      },
      async (request) => {
        attempts++;
        const refresh = request.operation === 'refreshTransaction';

        if (!refresh) {
          operationIds.push(request.operationId);

          if (!journal.has(request.operationId)) {
            writes++;
            journal.set(request.operationId, {
              message: 'Commented',
              commentId: '99',
            });
          }
        }

        if (attempts === 1 && failure === 'bridge-response')
          throw new Error('Bridge response lost after journaling the write');

        return {
          mutationState: refresh ? 'none' : 'confirmed',
          refreshState: 'current',
          output: refresh
            ? { message: 'Refreshed' }
            : journal.get(request.operationId),
          transaction: {
            ...transaction,
            commentCount: attempts === 1 ? 'invalid' : 1,
          },
        };
      },
    );

    try {
      const api = snapshot.consumer;
      const id = (await api.objects.Transaction.query()).data[0].id;
      const request = {
        input: { transaction: id, comment: 'Thanks' },
        idempotencyKey: 'same',
      };

      if (failure === 'bridge-response') {
        await assert.rejects(api.actions.commentOnTransaction(request), {
          code: 'internal',
        });
        const receipt = await api.actions.commentOnTransaction(request);

        assert.equal(receipt.output.commentId, '99');
        assert.equal(operationIds.length, 2);
        assert.equal(operationIds[0], operationIds[1]);
      } else {
        const receipt = await api.actions.commentOnTransaction(request);

        assert.equal(receipt.output.refreshState, 'pending');
        assert.equal(
          (await api.objects.Transaction.get(id)).data.syncState,
          'pending',
        );
        assert.deepEqual(
          await api.actions.commentOnTransaction(request),
          receipt,
        );
        assert.equal(attempts, 1);
        const recovered = await api.actions.refreshTransaction({
          input: { transaction: id },
          idempotencyKey: 'refresh-1',
        });

        assert.equal(recovered.output.refreshState, 'current');
        assert.equal(
          (await api.objects.Transaction.get(id)).data.commentCount,
          1,
        );
      }

      assert.equal(writes, 1);
    } finally {
      await snapshot.close();
    }
  });
}

test('saved libraries remain distinct from playlist songs and album association', async () => {
  const rows = {
    Person: [{ sourceId: 'me', email: 'me', name: 'Me' }],
    MusicLibrary: [{ sourceId: 'me', owner: 'me' }],
    Album: [{ sourceId: 'a', title: 'Saved album' }],
    Playlist: [{ sourceId: 'p', title: 'Playlist' }],
    Song: ['playlist-only', 'saved-song', 'album-song'].map((id, i) => ({
      sourceId: id,
      title: id,
      albumId: i === 1 ? null : 'a',
      duration: 60,
      genre: 'test',
      releaseDate: '2023-01-01',
      likeCount: 0,
      playCount: i,
      artistsJson: '[]',
    })),
    Membership: [{ sourceId: 'p:1', playlist: 'p', song: 'playlist-only' }],
    SavedSong: [{ sourceId: 's', library: 'me', song: 'saved-song' }],
    SavedAlbum: [{ sourceId: 'a', library: 'me', album: 'a' }],
    AlbumMembership: [{ sourceId: 'a:s', album: 'a', song: 'album-song' }],
  };
  const snapshot = await createSdkSnapshot(rows);
  try {
    const api = snapshot.consumer;
    const library = (await api.objects.MusicLibrary.query()).data[0];
    const songs = [];
    for await (const song of api.objects.MusicLibrary.traverse.savedSongs(
      library.id,
    ))
      songs.push(song.data);
    assert.deepEqual(
      songs.map((s) => s.title),
      ['saved-song'],
    );
    assert.equal(songs[0].albumId, null);
    const albumSongs = [];
    for await (const album of api.objects.MusicLibrary.traverse.savedAlbums(
      library.id,
    )) {
      for await (const song of api.objects.Album.traverse.songs(album.id))
        albumSongs.push(song.data.title);
    }
    assert.deepEqual(albumSongs, ['album-song']);
  } finally {
    await snapshot.close();
  }
});
