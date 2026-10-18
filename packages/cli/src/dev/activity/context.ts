import { AsyncLocalStorage } from 'node:async_hooks';
import { randomBytes } from 'node:crypto';
import type { OperationContext } from '@relate/protocol';

const current = new AsyncLocalStorage<Partial<OperationContext>>();

export const withActivityContext = <T>(
  context: Partial<OperationContext>,
  run: () => T,
): T => current.run(context, run);

export function dispatchScope(principal: string, runtimeId: string) {
  const bytes = randomBytes(16);

  bytes.writeUIntBE(Date.now(), 0, 6);
  bytes[6] = (bytes[6]! & 15) | 112;
  bytes[8] = (bytes[8]! & 63) | 128;
  const h = bytes.toString('hex'),
    id = `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;

  return {
    id,
    actor: { kind: 'principal' as const, id: principal },
    context: {
      requestId: id,
      transport: 'embedded' as const,
      ...current.getStore(),
      runtimeId,
    },
  };
}
