import { realpath, stat } from 'node:fs/promises';
import { dirname, isAbsolute, resolve } from 'node:path';

export const configCandidates = Object.freeze([
  'relate.config.ts',
  'relate.config.mts',
  'relate.config.js',
  'relate.config.mjs',
]);

export interface Project {
  /** Canonical real path of the directory holding the config: the lock identity. */
  readonly root: string;
  /** Canonical real path of the selected config module. */
  readonly configPath: string;
}

export class ProjectError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProjectError';
  }
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

/** Resolve the explicit `--config` or the first conventional candidate in `cwd`. */
export async function resolveProject(
  cwd: string,
  config: string | undefined,
): Promise<Project> {
  let selected: string | undefined;

  if (config !== undefined) {
    selected = isAbsolute(config) ? config : resolve(cwd, config);

    if (!(await isFile(selected)))
      throw new ProjectError(`Config not found: ${selected}`);
  } else {
    for (const candidate of configCandidates) {
      const path = resolve(cwd, candidate);

      if (await isFile(path)) {
        selected = path;
        break;
      }
    }

    if (!selected)
      throw new ProjectError(
        `No ${configCandidates.join(', ')} found in ${cwd}. Create one that exports your defineApp(...) or pass --config <path>.`,
      );
  }

  const configPath = await realpath(selected);

  return Object.freeze({ root: dirname(configPath), configPath });
}
