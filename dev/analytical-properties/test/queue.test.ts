import { expect, it, vi } from 'vitest';
import { StatementQueue } from '../queue.js';

it('bounds active work and waiting depth; queued cancellation never executes', async () => {
  const queue = new StatementQueue(1, 1, 1000);
  const signal = new AbortController().signal;
  let finish!: () => void;
  const first = queue.run(
    signal,
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  const controller = new AbortController();
  const execute = vi.fn(async () => 1);
  const second = queue.run(controller.signal, execute);

  await expect(queue.run(signal, execute)).rejects.toThrow('queue-full');
  controller.abort(new Error('cancelled'));
  await expect(second).rejects.toThrow('cancelled');
  finish();
  await first;
  expect(execute).not.toHaveBeenCalled();
  await expect(queue.run(signal, execute)).resolves.toBe(1);
});
it('expires queued work without releasing an active statement slot', async () => {
  const queue = new StatementQueue(1, 1, 10);
  const signal = new AbortController().signal;
  let finish!: () => void;
  const first = queue.run(
    signal,
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  const execute = vi.fn(async () => 1);

  await expect(queue.run(signal, execute)).rejects.toThrow('queue-wait');
  expect(execute).not.toHaveBeenCalled();
  finish();
  await first;
  await expect(queue.run(signal, execute)).resolves.toBe(1);
});
