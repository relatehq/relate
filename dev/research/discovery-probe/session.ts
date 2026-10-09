import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import type { CallRecord } from './repl.js';

const here = dirname(fileURLToPath(import.meta.url));

export const repositoryRoot = resolve(here, '../../..');

const childSources = ['child', 'repl', 'desk', 'goals', 'sdk'];
let childEntry: string | undefined;

/**
 * Transpile the child's modules to plain JavaScript once per host process. A
 * TypeScript loader would need worker threads, which the child is denied.
 */
function buildChild() {
  if (childEntry) return childEntry;

  const out = join(here, '.local/child');

  mkdirSync(out, { recursive: true });

  for (const name of childSources)
    writeFileSync(
      join(out, `${name}.js`),
      ts.transpileModule(readFileSync(join(here, `${name}.ts`), 'utf8'), {
        compilerOptions: {
          target: ts.ScriptTarget.ES2022,
          module: ts.ModuleKind.ESNext,
          verbatimModuleSyntax: false,
        },
      }).outputText,
    );

  return (childEntry = join(out, 'child.js'));
}

export interface CellResult {
  readonly output: string;
  readonly error: string | null;
  readonly calls: readonly CallRecord[];
  readonly submitted?: { readonly value: unknown };
  readonly timedOut?: true;
}

/**
 * One episode's REPL child. It gets no environment beyond PATH, so it never
 * sees the model credentials, and may read only code and dependencies.
 */
export async function openSession(options: {
  checkout: string;
  goal: string;
  cellTimeoutMs?: number;
}) {
  const checkout = realpathSync(options.checkout);
  const readable = [
    here,
    join(repositoryRoot, 'node_modules'),
    join(repositoryRoot, 'packages'),
    join(checkout, 'node_modules'),
    join(checkout, 'packages'),
  ];
  const child = spawn(
    process.execPath,
    [
      '--permission',
      ...readable.map((path) => `--allow-fs-read=${path}`),
      buildChild(),
    ],
    {
      cwd: here,
      env: { PATH: process.env.PATH ?? '' },
      stdio: ['pipe', 'pipe', 'pipe'],
    },
  );
  let stderr = '';

  child.stderr.on('data', (chunk) => (stderr += String(chunk)));

  const lines = createInterface({ input: child.stdout })[
    Symbol.asyncIterator
  ]();
  const request = async (message: unknown, timeoutMs = 60_000) => {
    child.stdin.write(`${JSON.stringify(message)}\n`);

    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => resolve('timeout'), timeoutMs);
    });
    const next = await Promise.race([lines.next(), timeout]);

    clearTimeout(timer);

    if (next === 'timeout') return 'timeout' as const;

    if (next.done)
      throw new Error(
        `REPL child exited unexpectedly:\n${stderr.slice(-2000)}`,
      );

    const reply = JSON.parse(next.value) as { type: string; error?: string };

    if (reply.type === 'error') throw new Error(`REPL child: ${reply.error}`);

    return reply as Record<string, unknown>;
  };
  const ready = await request(
    { type: 'init', checkout, goal: options.goal },
    120_000,
  );

  if (ready === 'timeout') {
    child.kill('SIGKILL');
    throw new Error('REPL child did not start');
  }

  return {
    truth: ready.truth,
    async execute(code: string): Promise<CellResult> {
      const reply = await request(
        { type: 'execute', code },
        options.cellTimeoutMs ?? 60_000,
      );

      if (reply === 'timeout') {
        child.kill('SIGKILL');

        return {
          output: 'Cell timed out; the interpreter was stopped.',
          error: 'Timeout',
          calls: [],
          timedOut: true,
        };
      }

      return reply as unknown as CellResult;
    },
    async close() {
      if (child.exitCode === null && !child.killed) {
        await request({ type: 'close' }, 10_000).catch(() => undefined);
        child.kill();
      }
    },
  };
}
