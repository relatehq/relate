/**
 * The development principal chosen in this browser. It belongs to the browser,
 * not the dev server: two tabs may act as different principals. Remembered per
 * graph in localStorage when available; the inspector works without it.
 */
import { useSyncExternalStore } from 'react';

const listeners = new Set<() => void>();
const chosen = new Map<string, string | null>();
const key = (graphId: string) => `relate.inspector.principal.${graphId}`;

function read(graphId: string): string | null {
  if (chosen.has(graphId)) return chosen.get(graphId)!;

  let value: string | null = null;

  try {
    value = globalThis.localStorage?.getItem(key(graphId)) ?? null;
  } catch {
    value = null;
  }

  chosen.set(graphId, value);

  return value;
}

export function choosePrincipal(graphId: string, principal: string): void {
  chosen.set(graphId, principal);

  try {
    globalThis.localStorage?.setItem(key(graphId), principal);
  } catch {
    // Storage is a convenience; the choice still applies to this page.
  }

  for (const listener of [...listeners]) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);

  return () => listeners.delete(listener);
}

/** The stored choice for a graph, which may no longer be declared. */
export function useChosenPrincipal(graphId: string | null): string | null {
  return useSyncExternalStore(
    subscribe,
    () => (graphId === null ? null : read(graphId)),
    () => null,
  );
}
