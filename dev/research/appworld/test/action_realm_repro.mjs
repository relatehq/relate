// Regression for the write pilot's resolved realm blocker. No AppWorld data or credentials.
// Run: node dev/research/appworld/test/action_realm_repro.mjs
import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';
import { createSdkSnapshot } from '../sdk-graph.mjs';

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
let writes = 0;
const snapshot = await createSdkSnapshot(
  {
    Person: [{ sourceId: 'me@test', name: 'Me', email: 'me@test' }],
    Transaction: [transaction],
  },
  async () => {
    writes++;

    return {
      transaction: { ...transaction, likeCount: writes },
      output: { message: 'Liked' },
    };
  },
);

try {
  const relate = snapshot.consumer;
  const id = (await relate.objects.Transaction.query()).data[0].id;
  const input = runInNewContext('({transaction: id})', { id });

  assert.notEqual(Object.getPrototypeOf(input), Object.prototype);
  await relate.actions.likeTransaction({ input, idempotencyKey: 'foreign' });
  assert.equal(writes, 1, 'Cross-realm input reaches the source write');
  await relate.actions.likeTransaction({
    input: { transaction: id },
    idempotencyKey: 'host',
  });
  await relate.actions.likeTransaction({
    input: structuredClone(input),
    idempotencyKey: 'cloned',
  });
  assert.equal(writes, 3);
  console.log(
    'PASS: VM plain object, host object and host-cloned object all succeed.',
  );
} finally {
  await snapshot.close();
}
