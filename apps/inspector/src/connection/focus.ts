/**
 * The activity request the developer is pointing at (hovering an agent tool
 * call). The graph highlights the objects that request's operations touched,
 * for as long as it stays focused. Browser-only state; nothing is sent.
 */
import { useSyncExternalStore } from 'react';

const listeners = new Set<() => void>();
let focused: string | null = null;

export function focusRequest(requestId: string | null): void {
  if (focused === requestId) return;

  focused = requestId;

  for (const listener of [...listeners]) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);

  return () => listeners.delete(listener);
}

export function useFocusedRequest(): string | null {
  return useSyncExternalStore(
    subscribe,
    () => focused,
    () => null,
  );
}
