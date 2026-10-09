import assert from 'node:assert/strict';
import test from 'node:test';
import { createSdkSnapshot } from '../sdk-graph.mjs';

test('SDK discovery and canonical payment references support a direction-correct query', async () => {
  const snapshot = await createSdkSnapshot({
    Person: [
      { sourceId: 'me@example.test', name: 'Me', relationshipsJson: '[]' },
      {
        sourceId: 'roommate@example.test',
        name: 'Roommate',
        relationshipsJson: '["roommate"]',
      },
    ],
    Transaction: [
      {
        sourceId: '1',
        sender: 'me@example.test',
        receiver: 'roommate@example.test',
        amount: 25,
        description: 'Shared bill',
        createdAt: '2023-01-02',
        likeCount: 0,
        commentCount: 0,
      },
      {
        sourceId: '2',
        sender: 'roommate@example.test',
        receiver: 'me@example.test',
        amount: 10,
        description: 'Return',
        createdAt: '2023-01-03',
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
      where: { sourceId: 'me@example.test' },
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
      { select: ['relationshipsJson'], evidence: 'full' },
    );

    assert.equal(receiver.data.relationshipsJson, '["roommate"]');
    assert.equal(receiver.meta.fields.relationshipsJson.status, 'available');
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
    createdAt: '2023-01-01',
    likeCount: 0,
    commentCount: 0,
  };
  const calls = [];
  const snapshot = await createSdkSnapshot(
    {
      Person: [{ sourceId: 'me@test', name: 'Me', relationshipsJson: '[]' }],
      Transaction: [transaction],
    },
    async (request) => {
      calls.push(request);
      if (request.operation === 'likeTransaction') transaction.likeCount++;
      else transaction.commentCount++;
      return {
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
      ['commentOnTransaction', 'likeTransaction'],
    );
    const request = {
      input: { transaction: id, comment: 'Thank you' },
      idempotencyKey: 'comment-1',
    };
    const receipt = await api.actions.commentOnTransaction(request);
    assert.equal(receipt.output.commentId, '99');
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
