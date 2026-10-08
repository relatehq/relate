/**
 * Watches the directories of every bundled input (and the config's directory)
 * so edits, atomic saves and newly created modules all trigger a rebuild.
 * Saves are debounced into one attempt.
 */
import { existsSync, watch } from 'node:fs';
import type { FSWatcher } from 'node:fs';
import { dirname, join, sep } from 'node:path';

export interface Watcher {
  /** Replace the watched set; the previous set stays until the new one is known. */
  update(inputs: readonly string[]): void;
  close(): void;
}

export interface WatcherOptions {
  readonly projectRoot: string;
  readonly debounceMs?: number;
  readonly onChange: (changedFiles: readonly string[]) => void;
  readonly onError?: (error: Error) => void;
}

export function createWatcher(options: WatcherOptions): Watcher {
  const watchers = new Map<string, FSWatcher>();
  let files = new Set<string>();
  let pending = new Set<string>();
  let timer: ReturnType<typeof setTimeout> | null = null;
  let closed = false;
  const flush = () => {
    timer = null;

    if (closed || pending.size === 0) return;

    const changed = [...pending].sort();

    pending = new Set();
    options.onChange(changed);
  };
  const schedule = (file: string) => {
    pending.add(file);

    if (timer) clearTimeout(timer);

    timer = setTimeout(flush, options.debounceMs ?? 80);
  };
  const watchDirectory = (directory: string) => {
    if (watchers.has(directory)) return;

    let watcher: FSWatcher;

    try {
      watcher = watch(directory, { persistent: true }, (_event, filename) => {
        if (closed) return;

        const name = filename === null ? null : String(filename);
        const path = name ? join(directory, name) : directory;

        // A known file, or an unknown name in a watched directory (a module
        // being created, or an editor's temporary rename), both rebuild.
        if (
          !name ||
          files.has(path) ||
          isSourceLike(name) ||
          [...files].some((file) => file.startsWith(path + sep))
        )
          schedule(path);
      });
    } catch (error) {
      options.onError?.(error as Error);

      return;
    }

    watcher.on('error', (error) => options.onError?.(error));
    watchers.set(directory, watcher);
  };

  return {
    update(inputs) {
      files = new Set(inputs);
      const directories = new Set([
        options.projectRoot,
        ...inputs.map((input) => {
          let directory = dirname(input);

          // An unresolved import may name a directory that does not exist yet.
          // Its nearest existing ancestor lets us observe directory creation.
          while (!existsSync(directory) && dirname(directory) !== directory)
            directory = dirname(directory);

          return directory;
        }),
      ]);

      for (const directory of directories) watchDirectory(directory);

      for (const [directory, watcher] of watchers)
        if (!directories.has(directory)) {
          watcher.close();
          watchers.delete(directory);
        }
    },
    close() {
      closed = true;

      if (timer) clearTimeout(timer);

      for (const watcher of watchers.values()) watcher.close();

      watchers.clear();
    },
  };
}

function isSourceLike(name: string): boolean {
  return /\.(?:[cm]?[jt]sx?|json)$/.test(name);
}
