import { createServer } from 'node:net';
import { once } from 'node:events';
import { expect, it, onTestFinished } from 'vitest';
import { createClientFactory } from '../src/client.js';

it('omits unsupported startup settings and cancels with the connected backend secret', async () => {
  const packets: Buffer[] = [];
  const sockets = new Set<import('node:net').Socket>();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.once('data', (packet) => {
      packets.push(packet);

      if (packet.readInt32BE(4) === 80877102) {
        socket.end();

        return;
      }

      const authentication = Buffer.from([82, 0, 0, 0, 8, 0, 0, 0, 0]);
      const key = Buffer.alloc(13);

      key[0] = 75;
      key.writeInt32BE(12, 1);
      key.writeInt32BE(123, 5);
      key.writeInt32BE(456, 9);
      socket.write(
        Buffer.concat([authentication, key, Buffer.from([90, 0, 0, 0, 5, 73])]),
      );
      socket.on('data', () => socket.end());
    });
  });

  onTestFinished(async () => {
    for (const socket of sockets) socket.destroy();

    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address() as import('node:net').AddressInfo;
  const factory = createClientFactory({
    url: `postgres://user@127.0.0.1:${address.port}/test`,
    startupTimeoutMs: 1000,
    cancelTimeoutMs: 1000,
  });
  const primary = factory('statement'),
    control = factory('control');

  await primary.connect();
  await control.connect();
  await control.cancel(primary);
  await control.end();
  await primary.end();
  expect(packets[0]!.toString()).not.toContain('statement_timeout');
  expect(packets).toHaveLength(2);
  expect([...packets[1]!]).toEqual([
    0, 0, 0, 16, 4, 210, 22, 46, 0, 0, 0, 123, 0, 0, 1, 200,
  ]);
});
