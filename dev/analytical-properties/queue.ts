import { SpikeError } from './contracts.js';

/** One instance per configured connection, shared across actors and resources. */
export class StatementQueue {
  private active = 0;
  private waiting: (() => void)[] = [];
  constructor(
    private concurrency = 4,
    private depth = 32,
    private waitMs = 2000,
  ) {}

  async run<T>(signal: AbortSignal, execute: () => Promise<T>): Promise<T> {
    signal.throwIfAborted();

    if (this.active >= this.concurrency) {
      if (this.waiting.length >= this.depth)
        throw new SpikeError('busy', 'queue-full');

      await new Promise<void>((resolve, reject) => {
        const remove = () => {
          this.waiting = this.waiting.filter((item) => item !== start);
          clearTimeout(timer);
          signal.removeEventListener('abort', abort);
        };
        const start = () => {
          remove();
          this.active++;
          resolve();
        };
        const abort = () => {
          remove();
          reject(signal.reason);
        };
        const timer = setTimeout(() => {
          remove();
          reject(new SpikeError('busy', 'queue-wait'));
        }, this.waitMs);

        signal.addEventListener('abort', abort, { once: true });
        this.waiting.push(start);
      });
    } else this.active++;

    try {
      signal.throwIfAborted();

      return await execute();
    } finally {
      this.active--;
      this.waiting[0]?.();
    }
  }
}
