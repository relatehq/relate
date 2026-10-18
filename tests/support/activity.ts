import { randomUUID } from 'node:crypto';
import type { AcceptAttribution, NativeCreation } from 'relate/storage';

/** Trusted attribution for a test-owned acceptance outside any runtime operation. */
export function testAttribution(
  overrides: Partial<AcceptAttribution> = {},
): AcceptAttribution {
  return {
    changeId: randomUUID(),
    operationId: randomUUID(),
    actor: { kind: 'system', id: 'test' },
    context: { requestId: randomUUID(), transport: 'embedded' },
    occurredAt: Date.now(),
    ...overrides,
  };
}

/** Creation provenance for a test-owned native insert. */
export function testCreation(
  overrides: Partial<NativeCreation> = {},
): NativeCreation {
  return {
    actor: { kind: 'system', id: 'test' },
    invocationId: randomUUID(),
    ...overrides,
  };
}
