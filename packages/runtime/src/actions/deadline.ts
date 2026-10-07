import { ActionError } from '@relate/protocol';
import type { NativeTransaction } from '../storage.js';

/** Revoke native capabilities before the rejected callback returns to its adapter. */
export function createActionDeadline(
  transaction: NativeTransaction,
  timeoutMs: number,
) {
  const expiresAt = performance.now() + timeoutMs;
  let active = true;
  let interrupt!: () => void;
  const interrupted = new Promise<never>((_, reject) => {
    interrupt = () => {
      active = false;
      reject(new ActionError('unavailable'));
    };
  });
  const timer = setTimeout(interrupt, timeoutMs);
  const check = () => {
    if (!active || performance.now() >= expiresAt)
      throw new ActionError('unavailable');
  };
  const guard = async <T>(operation: () => Promise<T>): Promise<T> => {
    check();
    const result = await operation();

    check();

    return result;
  };
  const guarded: NativeTransaction = {
    load: (...args) => guard(() => transaction.load(...args)),
    insert: (...args) => guard(() => transaction.insert(...args)),
    claim: (...args) => guard(() => transaction.claim(...args)),
    saveInvocation: (...args) =>
      guard(() => transaction.saveInvocation(...args)),
  };
  const close = () => {
    clearTimeout(timer);
    interrupt();
  };

  return {
    close,
    async run<T>(
      operation: (
        transaction: NativeTransaction,
        check: () => void,
      ) => Promise<T>,
    ): Promise<T> {
      try {
        return await Promise.race([
          guard(() => operation(guarded, check)),
          interrupted,
        ]);
      } finally {
        close();
      }
    },
  };
}
