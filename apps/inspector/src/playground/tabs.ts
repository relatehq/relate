/**
 * Open playground tabs, per graph. They belong to the browser, like the chosen
 * principal: kept in localStorage when available so a reload keeps work in
 * progress, and still usable in memory when storage is blocked. There is no
 * list of saved queries; closing a tab discards it.
 */
import { useSyncExternalStore } from 'react';

export interface Tab {
  readonly id: string;
  readonly name: string;
  readonly code: string;
}

export interface Tabs {
  readonly tabs: readonly Tab[];
  readonly active: string;
}

const listeners = new Set<() => void>();
const loaded = new Map<string, Tabs>();
const provisional = new Map<string, Tabs>();
const key = (graphId: string) => `relate.inspector.playground.${graphId}`;

export const starterCode = (object: string | null) =>
  object
    ? `// Runs as the principal chosen above, with \`graph\` injected.
// Ctrl+Space suggests; ⌘↵ runs.
const page = await graph.objects.${object}.query({ limit: 20 });

return page;
`
    : `// Runs as the principal chosen above, with \`graph\` injected.
return graph.describe();
`;

const newId = () => Math.random().toString(36).slice(2, 10);

function valid(value: unknown): value is Tabs {
  if (!value || typeof value !== 'object') return false;

  const { tabs, active } = value as Partial<Tabs>;

  return (
    Array.isArray(tabs) &&
    tabs.length > 0 &&
    tabs.every(
      (tab) =>
        typeof tab?.id === 'string' &&
        typeof tab.name === 'string' &&
        typeof tab.code === 'string',
    ) &&
    typeof active === 'string' &&
    tabs.some((tab) => tab.id === active)
  );
}

function read(graphId: string, object: string | null): Tabs {
  const cached = loaded.get(graphId);

  if (cached) return cached;

  let value: Tabs | null = null;

  try {
    const stored: unknown = JSON.parse(
      globalThis.localStorage?.getItem(key(graphId)) ?? 'null',
    );

    value = valid(stored) ? stored : null;
  } catch {
    value = null;
  }

  if (!value) {
    // Before discovery names an object, the first tab is provisional: an
    // untouched one is replaced by a starter that queries a real object.
    const pending = provisional.get(graphId);

    if (object === null && pending) return pending;

    const id = newId();

    value = {
      tabs: [{ id, name: 'Query 1', code: starterCode(object) }],
      active: id,
    };

    if (object === null) {
      provisional.set(graphId, value);

      return value;
    }
  }

  loaded.set(graphId, value);

  return value;
}

/** Typing updates tabs at once; storage is written after a pause, or on leaving. */
const saveDelayMs = 400;
const unsaved = new Map<string, ReturnType<typeof setTimeout>>();

function save(graphId: string): void {
  clearTimeout(unsaved.get(graphId));
  unsaved.delete(graphId);

  const value = loaded.get(graphId);

  if (!value) return;

  try {
    globalThis.localStorage?.setItem(key(graphId), JSON.stringify(value));
  } catch {
    // Storage is a convenience; the tabs still work on this page.
  }
}

globalThis.addEventListener?.('pagehide', () => {
  for (const graphId of [...unsaved.keys()]) save(graphId);
});

function write(graphId: string, value: Tabs): void {
  loaded.set(graphId, value);
  clearTimeout(unsaved.get(graphId));
  unsaved.set(
    graphId,
    setTimeout(() => save(graphId), saveDelayMs),
  );

  for (const listener of [...listeners]) listener();
}

export function useTabs(graphId: string, object: string | null): Tabs {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);

      return () => listeners.delete(listener);
    },
    () => read(graphId, object),
    () => read(graphId, object),
  );
}

export const tabActions = (graphId: string, object: string | null) => ({
  select(id: string) {
    const current = read(graphId, object);

    if (current.tabs.some((tab) => tab.id === id))
      write(graphId, { ...current, active: id });
  },
  edit(id: string, code: string) {
    const current = read(graphId, object);

    write(graphId, {
      ...current,
      tabs: current.tabs.map((tab) => (tab.id === id ? { ...tab, code } : tab)),
    });
  },
  add() {
    const current = read(graphId, object);
    const id = newId();
    const used = new Set(current.tabs.map((tab) => tab.name));
    let n = current.tabs.length + 1;

    while (used.has(`Query ${n}`)) n++;

    write(graphId, {
      tabs: [
        ...current.tabs,
        { id, name: `Query ${n}`, code: starterCode(object) },
      ],
      active: id,
    });
  },
  close(id: string) {
    const current = read(graphId, object);
    const index = current.tabs.findIndex((tab) => tab.id === id);

    if (index < 0 || current.tabs.length === 1) return;

    const tabs = current.tabs.filter((tab) => tab.id !== id);
    const active =
      current.active === id
        ? tabs[Math.min(index, tabs.length - 1)]!.id
        : current.active;

    write(graphId, { tabs, active });
  },
  rename(id: string, name: string) {
    const trimmed = name.trim();

    if (!trimmed) return;

    const current = read(graphId, object);

    write(graphId, {
      ...current,
      tabs: current.tabs.map((tab) =>
        tab.id === id ? { ...tab, name: trimmed.slice(0, 40) } : tab,
      ),
    });
  },
});
