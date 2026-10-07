/**
 * Incremental esbuild bundling of the config entry for Node. Each attempt
 * gets its own output directory so a superseded child never reads a bundle
 * that a newer attempt is writing. Source maps use absolute `file://` sources
 * so Node's `--enable-source-maps` resolves authored files from anywhere.
 */
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import * as esbuild from 'esbuild';
import type { Diagnostic } from '@relate/inspector/protocol';
import { devDirectory } from './lock.js';

export interface BuildSuccess {
  readonly ok: true;
  readonly bundlePath: string;
  /** Absolute paths of every bundled input, for the watcher. */
  readonly inputs: readonly string[];
}

export interface BuildFailure {
  readonly ok: false;
  readonly diagnostics: readonly Diagnostic[];
  /** Inputs esbuild still reported, if any; the watcher keeps the last good set too. */
  readonly inputs: readonly string[];
}

export type BuildResult = BuildSuccess | BuildFailure;

export interface Builder {
  build(attempt: number): Promise<BuildResult>;
  /** Remove an attempt's output once its child has exited. */
  discard(attempt: number): Promise<void>;
  dispose(): Promise<void>;
}

export function buildDirectory(projectRoot: string): string {
  return join(devDirectory(projectRoot), 'build');
}

function projectRelative(projectRoot: string, path: string): string {
  const rel = relative(projectRoot, path);

  return rel && !rel.startsWith('..') && !isAbsolute(rel)
    ? rel.split(sep).join('/')
    : path;
}

/** esbuild messages become syntax or import diagnostics with exact frames. */
export function esbuildDiagnostics(
  projectRoot: string,
  messages: readonly esbuild.Message[],
): Diagnostic[] {
  return messages.map((message) => {
    const resolution = /^Could not resolve/i.test(message.text);
    const location = message.location;
    const site = location
      ? {
          file: projectRelative(
            projectRoot,
            resolve(projectRoot, location.file),
          ),
          line: Math.max(1, location.line),
          column: Math.max(1, location.column + 1),
          precision: 'expression' as const,
        }
      : undefined;

    return {
      kind: resolution ? 'import' : 'syntax',
      code: resolution
        ? 'import.unresolved'
        : `syntax.${message.id || 'esbuild'}`,
      severity: 'error',
      message: message.text,
      ...(site ? { site } : {}),
      ...(site && location?.lineText !== undefined
        ? { frame: { ...site, excerpt: location.lineText } }
        : {}),
    };
  });
}

export async function createBuilder(options: {
  readonly projectRoot: string;
  readonly configPath: string;
}): Promise<Builder> {
  const root = buildDirectory(options.projectRoot);
  // A stable virtual outfile keeps esbuild's incremental state; attempts copy from it.
  const outfile = join(root, 'app.mjs');

  await mkdir(root, { recursive: true });
  const context = await esbuild.context({
    entryPoints: [options.configPath],
    absWorkingDir: options.projectRoot,
    outfile,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    // Only the project's own modules are bundled; dependencies load from node_modules.
    packages: 'external',
    sourcemap: 'linked',
    metafile: true,
    write: false,
    logLevel: 'silent',
    legalComments: 'none',
  });

  return {
    async build(attempt) {
      let result: esbuild.BuildResult<{ metafile: true; write: false }>;

      try {
        result = await context.rebuild();
      } catch (error) {
        const failure = error as Partial<esbuild.BuildFailure>;

        return {
          ok: false,
          diagnostics: failure.errors?.length
            ? esbuildDiagnostics(options.projectRoot, failure.errors)
            : [
                {
                  kind: 'syntax',
                  code: 'syntax.build-failed',
                  severity: 'error',
                  message:
                    error instanceof Error ? error.message : String(error),
                },
              ],
          inputs: [],
        };
      }

      const inputs = Object.keys(result.metafile?.inputs ?? {})
        .filter((input) => !input.includes(':'))
        .map((input) => resolve(options.projectRoot, input));

      if (result.errors.length)
        return {
          ok: false,
          diagnostics: esbuildDiagnostics(options.projectRoot, result.errors),
          inputs,
        };

      const directory = join(root, `attempt-${attempt}`);
      const bundlePath = join(directory, 'app.mjs');

      await mkdir(directory, { recursive: true });

      for (const file of result.outputFiles ?? []) {
        const target = join(directory, relative(root, file.path));

        if (target.endsWith('.map')) {
          const map = JSON.parse(file.text) as { sources?: string[] };

          map.sources = (map.sources ?? []).map(
            (source) => pathToFileURL(resolve(dirname(file.path), source)).href,
          );
          await writeFile(target, JSON.stringify(map));
        } else await writeFile(target, file.contents);
      }

      return { ok: true, bundlePath, inputs };
    },
    async discard(attempt) {
      await rm(join(root, `attempt-${attempt}`), {
        recursive: true,
        force: true,
      });
    },
    async dispose() {
      await context.dispose();
    },
  };
}
