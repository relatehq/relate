/**
 * Shared by the children that import user code (the compile worker and the
 * runtime host): resolve the project's own Relate packages and map stack
 * frames back to authored files.
 */
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { SourceSite } from 'relate/diagnostics';

export interface ChildSupport {
  /**
   * Prefer the project's own package so definition identity matches the
   * instance the user's modules import. Undefined when the project has none.
   */
  packageEntry(name: string, subpath: string): string | undefined;
  /** First stack frame in the user's project, outside libraries and the bundle. */
  userSite(
    stack: string | undefined,
    precision: SourceSite['precision'],
  ): SourceSite | undefined;
  projectRelative(path: string): string;
}

export function createChildSupport(options: {
  readonly projectRoot: string;
  readonly configPath: string;
  readonly bundlePath: string;
  /** The child's own module file, whose frames are never the user's. */
  readonly childFile: string;
}): ChildSupport {
  const buildDirectory = dirname(options.bundlePath);
  /** Package roots whose frames are library internals, not the user's declarations. */
  const libraryRoots: string[] = [];
  const projectRelative = (path: string) => {
    const rel = relative(options.projectRoot, path);

    return rel && !rel.startsWith('..') && !isAbsolute(rel)
      ? rel.split(sep).join('/')
      : path;
  };

  return {
    projectRelative,
    packageEntry(name, subpath) {
      let directory = dirname(options.configPath);

      for (;;) {
        const manifestPath = join(
          directory,
          'node_modules',
          name,
          'package.json',
        );

        if (existsSync(manifestPath)) {
          const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
            exports?: Record<string, { import?: string } | string>;
          };
          const entry = manifest.exports?.[subpath];
          const target = typeof entry === 'string' ? entry : entry?.import;
          // Linked workspace packages resolve through symlinks and source maps.
          const root = realpathSync(dirname(manifestPath));

          if (!libraryRoots.includes(root)) libraryRoots.push(root);

          return target ? resolve(dirname(manifestPath), target) : undefined;
        }

        const parent = dirname(directory);

        if (parent === directory) return undefined;

        directory = parent;
      }
    },
    userSite(stack, precision) {
      if (!stack) return undefined;

      for (const line of stack.split('\n')) {
        const match = /\(?((?:file:\/\/)?[^():\s]+):(\d+):(\d+)\)?\s*$/.exec(
          line.trim(),
        );

        if (!match || !line.trim().startsWith('at ')) continue;

        let file = match[1]!;

        if (file.startsWith('node:')) continue;

        if (file.startsWith('file://')) {
          try {
            file = fileURLToPath(file);
          } catch {
            continue;
          }
        }

        if (
          file === options.childFile ||
          file.includes(`${sep}node_modules${sep}`) ||
          file.startsWith(buildDirectory + sep) ||
          libraryRoots.some((root) => file.startsWith(root + sep))
        )
          continue;

        return {
          file: projectRelative(file),
          line: Number(match[2]),
          column: Number(match[3]),
          precision,
        };
      }

      return undefined;
    },
  };
}

export function sanitizeMessage(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`;

  return typeof error === 'string' ? error : 'Unknown error';
}

/** Structural: the project's `relate` may be a different module instance. */
export function isCompileError(error: unknown): error is Error & {
  issues: readonly import('relate/diagnostics').ModelIssue[];
} {
  return (
    error instanceof Error &&
    error.name === 'CompileError' &&
    Array.isArray((error as { issues?: unknown }).issues)
  );
}

/** A config's default export: `defineApp(...)`, or a bare `defineGraph(...)` result. */
export function selectExport(module: Record<string, unknown>):
  | {
      readonly kind: 'app';
      readonly app: { readonly graph: object; readonly setup?: unknown };
    }
  | { readonly kind: 'graph'; readonly graph: object }
  | undefined {
  for (const candidate of [module.default, module.app, module.graph]) {
    if (!candidate || typeof candidate !== 'object') continue;

    const value = candidate as {
      kind?: unknown;
      graph?: unknown;
      objects?: unknown;
      policies?: unknown;
    };

    if (
      value.kind === 'relate.app' &&
      value.graph &&
      typeof value.graph === 'object'
    )
      return {
        kind: 'app',
        app: candidate as { readonly graph: object; readonly setup?: unknown },
      };

    if (
      value.objects &&
      typeof value.objects === 'object' &&
      value.policies &&
      typeof value.policies === 'object'
    )
      return { kind: 'graph', graph: candidate };
  }

  return undefined;
}
