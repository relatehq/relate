import { createConsumer } from 'relate/consumer';
import type { ConsumerOperations, Json } from '@relate/protocol';
import { snapshotDiscovery } from './binding.js';
import type { BindingSnapshot } from './binding.js';
import { restoreError } from './wire.js';
import type { Operation, WireError } from './wire.js';

let sequence = 0;
const pending = new Map<
  number,
  { resolve(value: unknown): void; reject(error: Error): void }
>();

function rpc(operation: Operation, args: unknown[]): Promise<unknown> {
  const id = ++sequence;

  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    process.send!({ type: 'operation', id, operation, args }, (error) => {
      if (error) {
        pending.delete(id);
        reject(error);
      }
    });
  });
}

process.on(
  'message',
  (message: {
    type: string;
    id: number;
    value: unknown;
    error?: WireError;
    code: string;
    snapshot: BindingSnapshot;
    maxOutputBytes: number;
  }) => {
    if (message.type === 'reply') {
      const call = pending.get(message.id);

      pending.delete(message.id);

      if (message.error) call?.reject(restoreError(message.error));
      else call?.resolve(message.value);
    }

    if (message.type === 'start') void run(message);
  },
);

async function flushOutput() {
  await Promise.all(
    [process.stdout, process.stderr].map(
      (stream) =>
        new Promise<void>((resolve, reject) => {
          stream.write('', (error) => (error ? reject(error) : resolve()));
        }),
    ),
  );
}

async function run({
  code,
  snapshot,
  maxOutputBytes,
}: {
  code: string;
  snapshot: BindingSnapshot;
  maxOutputBytes: number;
}) {
  try {
    const operations: ConsumerOperations = {
      discovery: snapshotDiscovery(snapshot),
      get: (...args) =>
        rpc('get', args) as ReturnType<ConsumerOperations['get']>,
      query: (...args) =>
        rpc('query', args) as ReturnType<ConsumerOperations['query']>,
      traverse: (...args) =>
        rpc('traverse', args) as ReturnType<ConsumerOperations['traverse']>,
      invoke: (...args) =>
        rpc('invoke', args) as ReturnType<ConsumerOperations['invoke']>,
      getReceipt: (...args) =>
        rpc('getReceipt', args) as ReturnType<ConsumerOperations['getReceipt']>,
    };
    const graph = createConsumer(snapshot.description, operations);
    const AsyncFunction = Object.getPrototypeOf(async function () {})
      .constructor as new (
      ...args: string[]
    ) => (graph: unknown) => Promise<unknown>;
    const value = await new AsyncFunction('graph', '"use strict";\n' + code)(
      graph,
    );
    // JSON is the result contract, including undefined -> null for no return.
    const encoded = JSON.stringify(value === undefined ? null : value);

    if (encoded === undefined)
      throw new Error('Return a JSON-serializable value');

    if (Buffer.byteLength(encoded) > maxOutputBytes) {
      process.send!({
        type: 'failed',
        error: {
          name: 'OutputLimitError',
          code: 'output-limit',
          message: 'Execution output limit exceeded',
        },
      });

      return;
    }

    await flushOutput();
    process.send!({ type: 'result', value: JSON.parse(encoded) as Json });
  } catch (error) {
    await flushOutput();
    process.send!({
      type: 'failed',
      error: {
        name: error instanceof Error ? error.name : 'Error',
        message: error instanceof Error ? error.message : String(error),
        ...(error &&
        typeof error === 'object' &&
        'code' in error &&
        typeof error.code === 'string'
          ? { code: error.code }
          : {}),
      },
    });
  }
}
