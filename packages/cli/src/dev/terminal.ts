/**
 * Terminal renderer for `relate dev`. Append-only; plain text when redirected,
 * color and symbols only on a TTY. Diagnostics print `path:line:column` tokens
 * unobscured so editors can recognize them.
 */
import { isAbsolute, relative, resolve } from 'node:path';
import type { Writable } from 'node:stream';
import type { Manifest } from 'relate/model';
import { formatIssuePath } from 'relate/diagnostics';
import type { Diagnostic } from '@relate/inspector/protocol';
import { describeManifest } from './diff.js';

export interface TerminalOptions {
  readonly stdout: Writable;
  readonly stderr: Writable;
  /** Where the command was invoked: terminal paths are relative to it. */
  readonly cwd: string;
  readonly projectRoot: string;
  readonly color: boolean;
}

export interface Terminal {
  banner(info: {
    readonly project: string;
    readonly config: string;
    readonly inspectorUrl: string;
  }): void;
  notice(message: string): void;
  warn(message: string): void;
  loading(attempt: number): void;
  ready(generation: number, manifest: Manifest, durationMs: number): void;
  update(
    files: readonly string[],
    generation: number,
    summary: string,
    durationMs: number,
  ): void;
  error(
    files: readonly string[],
    attempt: number,
    diagnostics: readonly Diagnostic[],
    keptGeneration: number | null,
  ): void;
  startupError(message: string): void;
  childStdout(line: string): void;
  childStderr(line: string): void;
}

const codes = {
  dim: ['\u001b[2m', '\u001b[22m'],
  bold: ['\u001b[1m', '\u001b[22m'],
  green: ['\u001b[32m', '\u001b[39m'],
  yellow: ['\u001b[33m', '\u001b[39m'],
  red: ['\u001b[31m', '\u001b[39m'],
  cyan: ['\u001b[36m', '\u001b[39m'],
} as const;

export function shouldColor(
  stream: { isTTY?: boolean },
  env: NodeJS.ProcessEnv,
): boolean {
  return Boolean(stream.isTTY) && !env.NO_COLOR && env.TERM !== 'dumb';
}

export function createTerminal(options: TerminalOptions): Terminal {
  const paint = (style: keyof typeof codes, text: string) =>
    options.color ? `${codes[style][0]}${text}${codes[style][1]}` : text;
  const out = (line: string) => options.stdout.write(`${line}\n`);
  const err = (line: string) => options.stderr.write(`${line}\n`);
  const displayPath = (projectRelativeFile: string) => {
    const absolute = isAbsolute(projectRelativeFile)
      ? projectRelativeFile
      : resolve(options.projectRoot, projectRelativeFile);
    const rel = relative(options.cwd, absolute);

    return rel && !rel.startsWith('..') ? rel : absolute;
  };
  const fileList = (files: readonly string[]) => {
    if (files.length === 0) return '';

    const first = displayPath(files[0]!);

    return files.length > 1 ? `${first} (+${files.length - 1} files)` : first;
  };
  const pad = (text: string, width: number) => text.padEnd(width);

  return {
    banner({ project, config, inspectorUrl }) {
      out(`  ${paint('bold', 'Relate dev')}`);
      out(`  ${pad('Project', 10)} ${project}`);
      out(`  ${pad('Config', 10)} ${displayPath(config)}`);
      out(`  ${pad('Inspector', 10)} ${paint('cyan', inspectorUrl)}`);
      out(`  ${pad('Watching', 10)} application definitions`);
    },
    notice(message) {
      out(`  ${paint('dim', message)}`);
    },
    warn(message) {
      err(`  ${paint('yellow', 'warn')}   ${message}`);
    },
    loading(attempt) {
      out(`  ${pad('Loading', 10)} attempt ${attempt}`);
    },
    ready(generation, manifest, durationMs) {
      out('');
      out(
        `  ${paint('green', 'ready')}  gen ${generation}  ${describeManifest(manifest)}  ${paint('dim', `${durationMs}ms`)}`,
      );
    },
    update(files, generation, summary, durationMs) {
      out(
        `  ${paint('green', 'update')} ${pad(fileList(files), 28)} gen ${generation}  ${summary}  ${paint('dim', `${durationMs}ms`)}`,
      );
    },
    error(files, attempt, diagnostics, keptGeneration) {
      const count = `${diagnostics.length} issue${diagnostics.length === 1 ? '' : 's'}`;
      const kept =
        keptGeneration === null
          ? 'no model yet'
          : `keeping gen ${keptGeneration}`;
      const loader = diagnostics.every((d) => d.kind === 'worker');

      err(
        `  ${paint('red', 'error')}  ${pad(fileList(files), 28)} attempt ${attempt}  ${count}; ${kept}${
          loader ? '  (loader failure, not a definition error)' : ''
        }`,
      );

      for (const diagnostic of diagnostics) {
        err(`    ${paint('bold', diagnostic.code)}: ${diagnostic.message}`);

        const site = diagnostic.site ?? diagnostic.frame;

        if (site) {
          const label =
            site.precision === 'expression'
              ? 'expression'
              : diagnostic.kind === 'compile'
                ? `${diagnosticSubject(diagnostic)} declaration`
                : 'location';

          err(
            `    ${displayPath(site.file)}:${site.line}:${site.column} (${label})`,
          );
        }

        if (diagnostic.kind === 'compile') {
          if (diagnostic.path)
            err(
              `    ${capitalize(diagnostic.path.root)} path: ${formatIssuePath(diagnostic.path).slice(diagnostic.path.root.length + 1)}`,
            );

          if (diagnostic.definitionId)
            err(`    Definition: ${diagnostic.definitionId}`);

          if (!site) err('    Source location unavailable');
        }

        if (diagnostic.frame?.excerpt)
          for (const line of diagnostic.frame.excerpt.split('\n').slice(0, 6))
            err(`      ${paint('dim', line)}`);
      }
    },
    startupError(message) {
      err(`  ${paint('red', 'error')}  ${message}`);
    },
    childStdout(line) {
      out(line);
    },
    childStderr(line) {
      err(line);
    },
  };
}

function diagnosticSubject(diagnostic: Diagnostic): string {
  if (diagnostic.kind !== 'compile') return 'source';

  const head = diagnostic.path?.segments[0];

  switch (head) {
    case 'objects':
      return 'object';
    case 'relationships':
      return 'relationship';
    case 'actions':
      return 'action';
    case 'properties':
      return 'object';
    default:
      return 'graph';
  }
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}
