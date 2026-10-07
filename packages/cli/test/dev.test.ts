/**
 * Process tests for `relate dev`: a real supervisor, real children, a fixture
 * project that resolves `relate` through the workspace.
 */
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, it } from 'vitest';
import { parseDevEvent } from '@relate/inspector/protocol';
import type { DevEvent } from '@relate/inspector/protocol';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const binary = join(repoRoot, 'packages/cli/bin/relate.js');

const graphSource = (role: string) => `import { z } from 'zod';
import {
  defineAccess, defineGraph, defineObject, defineRelationship, defineSource,
  from, native, nativeMembership, objectId, reference, source,
} from 'relate';

const access = defineAccess({ roles: ['reader'], fieldGroups: ['ordinary'], claims: {} });
const customers = defineSource({
  id: 'crm.customers',
  idField: 'id',
  schema: z.object({ id: z.string(), name: z.string() }),
});
export const Customer = defineObject({
  id: 'business.customer',
  label: 'Customer',
  membership: source(customers),
  properties: {
    id: objectId({ id: 'customer.id' }),
    name: from(customers.fields.name, { id: 'customer.name' }),
  },
});
export const AccountReview = defineObject({
  id: 'business.account-review',
  label: 'Account review',
  membership: nativeMembership(),
  properties: {
    id: objectId({ id: 'review.id' }),
    customer: reference(Customer, { id: 'review.customer' }),
    note: native(z.string(), { id: 'review.note' }),
  },
});
const CustomerReviews = defineRelationship({
  id: 'business.customer-reviews',
  forward: 'reviews',
  reverse: 'customer',
  via: AccountReview.properties.customer,
});
export const graph = defineGraph({
  id: 'business',
  objects: { Customer, AccountReview },
  relationships: { CustomerReviews },
  access,
  policies: {
    Customer: { read: { gate: access.role('${role}') } },
    AccountReview: { read: { gate: access.role('reader') } },
  },
});
`;

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();

    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as { port: number }).port;

      server.close(() => resolve(port));
    });
  });
}

interface Project {
  readonly root: string;
  write(file: string, content: string): Promise<void>;
}

async function createProject(): Promise<Project> {
  const root = await mkdtemp(join(tmpdir(), 'relate-dev-test-'));

  await symlink(join(repoRoot, 'node_modules'), join(root, 'node_modules'));
  await mkdir(join(root, 'src/relate'), { recursive: true });
  await writeFile(
    join(root, 'relate.config.ts'),
    "export { default } from './src/relate/app.js';\n",
  );
  await writeFile(
    join(root, 'src/relate/app.ts'),
    "import { defineApp } from '@relate/node';\nimport { graph } from './graph.js';\n\nexport default defineApp({ graph });\n",
  );
  await writeFile(join(root, 'src/relate/graph.ts'), graphSource('reader'));

  return {
    root,
    write: (file, content) => writeFile(join(root, file), content),
  };
}

interface Dev {
  readonly child: ChildProcess;
  readonly url: string;
  readonly token: string;
  readonly stdout: string[];
  readonly stderr: string[];
  waitForStdout(pattern: RegExp, timeoutMs?: number): Promise<string>;
  waitForStderr(pattern: RegExp, timeoutMs?: number): Promise<string>;
  stop(): Promise<number | null>;
}

const running: Dev[] = [];
const projects: string[] = [];

function lines(buffer: { text: string }, chunk: Buffer, into: string[]) {
  buffer.text += chunk.toString('utf8');
  const parts = buffer.text.split('\n');

  buffer.text = parts.pop() ?? '';
  into.push(...parts);
}

async function startDev(project: Project, args: string[] = []): Promise<Dev> {
  const port = await freePort();
  const child = spawn(
    process.execPath,
    [binary, 'dev', '--port', String(port), ...args],
    {
      cwd: project.root,
      env: { ...process.env, NO_COLOR: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  const stdout: string[] = [];
  const stderr: string[] = [];
  const outBuffer = { text: '' };
  const errBuffer = { text: '' };

  child.stdout!.on('data', (chunk: Buffer) => lines(outBuffer, chunk, stdout));
  child.stderr!.on('data', (chunk: Buffer) => lines(errBuffer, chunk, stderr));
  const waitFor = (into: string[], pattern: RegExp, timeoutMs: number) =>
    new Promise<string>((resolve, reject) => {
      const started = Date.now();
      const poll = () => {
        const found = into.find((line) => pattern.test(line));

        if (found !== undefined) return resolve(found);

        if (child.exitCode !== null)
          return reject(
            new Error(
              `relate dev exited (${child.exitCode}) before ${pattern}:\n${stdout.join('\n')}\n${stderr.join('\n')}`,
            ),
          );

        if (Date.now() - started > timeoutMs)
          return reject(
            new Error(
              `Timed out waiting for ${pattern}:\n${stdout.join('\n')}\n${stderr.join('\n')}`,
            ),
          );

        setTimeout(poll, 25);
      };

      poll();
    });
  const dev: Dev = {
    child,
    url: `http://127.0.0.1:${port}`,
    token: '',
    stdout,
    stderr,
    waitForStdout: (pattern, timeoutMs = 15_000) =>
      waitFor(stdout, pattern, timeoutMs),
    waitForStderr: (pattern, timeoutMs = 15_000) =>
      waitFor(stderr, pattern, timeoutMs),
    stop: () =>
      new Promise((resolve) => {
        if (child.exitCode !== null) return resolve(child.exitCode);

        child.once('exit', (code) => resolve(code));
        child.kill('SIGINT');
      }),
  };

  running.push(dev);
  const banner = await dev.waitForStdout(
    /Inspector\s+http:\/\/127\.0\.0\.1:\d+\/#token=/,
  );
  const token = /#token=([A-Za-z0-9_-]+)/.exec(banner)![1]!;

  return { ...dev, token };
}

afterEach(async () => {
  for (const dev of running.splice(0)) await dev.stop();

  for (const root of projects.splice(0))
    await rm(root, { recursive: true, force: true });
});

async function openSession(dev: Dev): Promise<string> {
  const response = await fetch(`${dev.url}/dev/session`, {
    method: 'POST',
    headers: { origin: dev.url, 'content-type': 'application/json' },
    body: JSON.stringify({ token: dev.token }),
  });

  expect(response.status).toBe(204);

  return (response.headers.get('set-cookie') ?? '').split(';')[0]!;
}

async function* events(dev: Dev, cookie: string): AsyncGenerator<DevEvent> {
  const response = await fetch(`${dev.url}/dev/events`, {
    headers: { cookie },
  });
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  try {
    for (;;) {
      const index = buffer.indexOf('\n\n');

      if (index !== -1) {
        const chunk = buffer.slice(0, index);

        buffer = buffer.slice(index + 2);

        if (!chunk.includes('event: heartbeat'))
          yield parseDevEvent(
            JSON.parse(
              chunk
                .split('\n')
                .filter((line) => line.startsWith('data:'))
                .map((line) => line.slice(5).trim())
                .join(''),
            ),
          );

        continue;
      }

      const { value, done } = await reader.read();

      if (done) return;

      buffer += decoder.decode(value, { stream: true });
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}

async function take(
  stream: AsyncGenerator<DevEvent>,
  timeoutMs = 15_000,
): Promise<DevEvent> {
  const timer = new Promise<never>((_, reject) =>
    setTimeout(
      () => reject(new Error('Timed out waiting for an event')),
      timeoutMs,
    ),
  );
  const next = await Promise.race([stream.next(), timer]);

  if (next.done) throw new Error('Event stream ended');

  return next.value;
}

it('prints the URL before the first model, then publishes models and failures over SSE as files change', async () => {
  const project = await createProject();

  projects.push(project.root);
  const dev = await startDev(project);
  const bannerIndex = dev.stdout.findIndex((line) =>
    /Inspector\s+http/.test(line),
  );
  const ready = await dev.waitForStdout(
    /^\s+ready\s+gen 1\s+business\s+2 objects · 1 source · 1 relationship\s+\d+ms$/,
  );

  expect(dev.stdout.indexOf(ready)).toBeGreaterThan(bannerIndex);
  expect(dev.stdout.join('\n')).not.toMatch(/API\s+http/);

  // Bare requests cannot read metadata; the terminal token can.
  expect((await fetch(`${dev.url}/dev/snapshot`)).status).toBe(401);
  const cookie = await openSession(dev);
  const stream = events(dev, cookie);
  const snapshot = await take(stream);

  expect(snapshot).toMatchObject({
    type: 'snapshot',
    model: { generation: 1 },
  });

  // A semantic mistake keeps generation 1 and reports a structured issue with its site.
  await project.write('src/relate/graph.ts', graphSource('finanse'));
  const failure = await take(stream);

  expect(failure).toMatchObject({
    type: 'diagnostics',
    attempt: 2,
    diagnostics: [
      {
        kind: 'compile',
        severity: 'error',
        code: 'policy.unknown-role',
        definitionId: 'business.customer',
        path: {
          root: 'graph',
          segments: ['policies', 'Customer', 'read', 'gate'],
        },
        site: { file: 'src/relate/graph.ts', precision: 'declaration' },
      },
    ],
  });
  const errorLine = await dev.waitForStderr(
    /^\s+error\s+src\/relate\/graph\.ts\s+attempt 2\s+1 issue; keeping gen 1$/,
  );

  expect(errorLine).toBeTruthy();
  expect(dev.stderr.join('\n')).toMatch(
    /policy\.unknown-role: Unknown policy role 'finanse'/,
  );
  expect(dev.stderr.join('\n')).toMatch(
    /src\/relate\/graph\.ts:\d+:\d+ \(graph declaration\)/,
  );
  expect(dev.stderr.join('\n')).toMatch(
    /Graph path: policies\.Customer\.read\.gate/,
  );

  // Recovery publishes the next generation and clears the failure atomically.
  await project.write('src/relate/graph.ts', graphSource('reader'));
  const recovered = await take(stream);

  expect(recovered).toMatchObject({
    type: 'model',
    model: { generation: 2 },
    fromGeneration: 1,
  });
  await dev.waitForStdout(
    /^\s+update\s+src\/relate\/graph\.ts\s+gen 2\s+model unchanged\s+\d+ms$/,
  );

  // A syntax error is a syntax diagnostic with an exact frame.
  await project.write(
    'src/relate/app.ts',
    "import { defineApp } from '@relate/node';\nconst broken = ;\n",
  );
  const syntax = await take(stream);

  expect(syntax).toMatchObject({
    type: 'diagnostics',
    attempt: 4,
    diagnostics: [
      {
        kind: 'syntax',
        severity: 'error',
        site: { file: 'src/relate/app.ts', line: 2, precision: 'expression' },
        frame: { excerpt: 'const broken = ;' },
      },
    ],
  });

  // Import-time failures are import diagnostics, never worker failures.
  await project.write(
    'src/relate/app.ts',
    "import { defineApp } from '@relate/node';\nimport { graph } from './graph.js';\nif (!process.env.RELATE_TEST_MISSING_KEY) throw new Error('CRM_API_KEY is required');\nexport default defineApp({ graph });\n",
  );
  const imported = await take(stream);

  expect(imported).toMatchObject({
    type: 'diagnostics',
    attempt: 5,
    diagnostics: [
      {
        kind: 'import',
        code: 'import.failed',
        severity: 'error',
        message: 'Error: CRM_API_KEY is required',
        site: { file: 'src/relate/app.ts', line: 3, precision: 'expression' },
      },
    ],
  });

  // Child console output is prefixed per stream; it never becomes a protocol message.
  await project.write(
    'src/relate/app.ts',
    "import { defineApp } from '@relate/node';\nimport { graph } from './graph.js';\nconsole.log('{\"type\":\"model\"}');\nconsole.error('Fixture configuration is incomplete');\nexport default defineApp({ graph });\n",
  );
  const published = await take(stream);

  expect(published).toMatchObject({ type: 'model', model: { generation: 3 } });
  await dev.waitForStdout(/^\[app attempt 6 stdout\] \{"type":"model"\}$/);
  await dev.waitForStderr(
    /^\[app attempt 6 stderr\] Fixture configuration is incomplete$/,
  );

  // A second invocation for the same project uses the existing server and exits 0.
  const duplicate = spawn(
    process.execPath,
    [binary, 'dev', '--port', new URL(dev.url).port],
    {
      cwd: project.root,
      env: { ...process.env, NO_COLOR: '1' },
    },
  );
  const duplicateOutput: Buffer[] = [];

  duplicate.stdout.on('data', (chunk: Buffer) => duplicateOutput.push(chunk));
  const duplicateExit = await new Promise<number | null>((resolve) =>
    duplicate.once('exit', (code) => resolve(code)),
  );

  expect(duplicateExit).toBe(0);
  expect(Buffer.concat(duplicateOutput).toString('utf8')).toMatch(
    /Relate dev is already running for .*\nInspector\s+http:\/\/127\.0\.0\.1:\d+\nConfig\s+.*relate\.config\.ts\nPID\s+\d+/,
  );

  await stream.return(undefined);
  expect(await dev.stop()).toBe(0);
  expect(await fetch(`${dev.url}/dev/instance`).catch(() => null)).toBeNull();
}, 60_000);

it('times out a child that never settles, reports one worker diagnostic and recovers on the next edit', async () => {
  const project = await createProject();

  projects.push(project.root);
  await project.write(
    'src/relate/app.ts',
    "import { defineApp } from '@relate/node';\nimport { graph } from './graph.js';\nfor (;;) {}\nexport default defineApp({ graph });\n",
  );
  const dev = await startDev(project, ['--eval-timeout', '1500']);
  const cookie = await openSession(dev);
  const stream = events(dev, cookie);
  const first = await take(stream);

  expect(first.type).toBe('snapshot');

  const snapshot = await (async () => {
    let current = first;

    while (current.type === 'snapshot' && !current.failure)
      current = await take(stream);

    return current;
  })();
  const failure = snapshot.type === 'snapshot' ? snapshot.failure! : snapshot;

  expect(failure).toMatchObject({
    attempt: 1,
    diagnostics: [
      { kind: 'worker', code: 'worker.timeout', severity: 'error' },
    ],
  });
  await dev.waitForStderr(
    /attempt 1\s+1 issue; no model yet\s+\(loader failure, not a definition error\)/,
  );
  expect(dev.stderr.filter((line) => /worker\./.test(line))).toHaveLength(1);

  // The inspector URL and the host stayed alive; a fix recovers.
  expect((await fetch(`${dev.url}/dev/instance`)).status).toBe(200);
  await project.write(
    'src/relate/app.ts',
    "import { defineApp } from '@relate/node';\nimport { graph } from './graph.js';\nexport default defineApp({ graph });\n",
  );
  const model = await take(stream, 20_000);

  expect(model).toMatchObject({
    type: 'model',
    model: { generation: 1 },
    fromGeneration: null,
  });
  await stream.return(undefined);
}, 60_000);

it('fails fast on invalid arguments, a missing config and an occupied explicit port', async () => {
  const project = await createProject();

  projects.push(project.root);
  const run = (args: string[], cwd = project.root) =>
    new Promise<{ code: number | null; stdout: string; stderr: string }>(
      (resolve) => {
        const child = spawn(process.execPath, [binary, 'dev', ...args], {
          cwd,
          env: { ...process.env, NO_COLOR: '1' },
        });
        const out: Buffer[] = [];
        const err: Buffer[] = [];

        child.stdout.on('data', (chunk: Buffer) => out.push(chunk));
        child.stderr.on('data', (chunk: Buffer) => err.push(chunk));
        child.once('exit', (code) =>
          resolve({
            code,
            stdout: Buffer.concat(out).toString('utf8'),
            stderr: Buffer.concat(err).toString('utf8'),
          }),
        );
      },
    );

  const usage = await run(['--port', 'abc']);

  expect(usage.code).toBe(2);
  expect(usage.stderr).toMatch(/--port requires an integer/);
  expect(usage.stderr).toMatch(/Usage: relate dev/);

  const missing = await run([], tmpdir());

  expect(missing.code).toBe(1);
  expect(missing.stderr).toMatch(/No relate\.config\.ts/);

  const dev = await startDev(project);
  const occupied = await run(['--port', new URL(dev.url).port], join(tmpdir()));

  expect(occupied.code).toBe(1);
  expect(occupied.stderr).toMatch(/No relate\.config/);
}, 60_000);
