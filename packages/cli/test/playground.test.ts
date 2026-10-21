/**
 * `/dev/playground/*`: discovery and runs over real HTTP against the dev
 * server, backed by a real runtime host started from the built CLI. Each test
 * writes its own application module.
 */
import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createAdaptorServer } from '@hono/node-server';
import { afterEach, expect, it } from 'vitest';
import {
  Supervisor,
  createActivityLog,
  createDevServer,
  createPlayground,
  createRuntimeController,
  createSessions,
} from '@relate/cli';
import type { ActivityLog } from '@relate/cli';
import {
  playgroundDiscoverySchema,
  playgroundRunSchema,
} from '@relate/inspector/protocol';
import type {
  ActivityEvent,
  PlaygroundRun,
  RuntimeStatus,
} from '@relate/inspector/protocol';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

/** Notes alice may read and bob may not, with one seeded note. */
function noteApp() {
  return `import { z } from 'zod';
import {
  defineAccess, defineApp, defineGraph, defineObject,
  native, nativeMembership, objectId,
} from 'relate';

const access = defineAccess({
  roles: ['reader'],
  fieldGroups: ['ordinary'],
  claims: {},
});
const Note = defineObject({
  id: 'notes.note',
  description: 'A short note.',
  membership: nativeMembership(),
  properties: {
    id: objectId({ id: 'note.id' }),
    body: native(z.string(), { id: 'note.body' }),
  },
});
export const graph = defineGraph({
  id: 'notes',
  objects: { Note },
  access,
  policies: { Note: { read: { gate: access.role('reader') } } },
  principals: { alice: { roles: ['reader'] }, bob: { roles: [] } },
});

export default defineApp({ graph, setup: () => ({ connections: [] }) });
`;
}

const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function waitUntil<T>(
  read: () => T | undefined,
  what: string,
  timeoutMs = 15_000,
): Promise<T> {
  const started = Date.now();

  for (;;) {
    const value = read();

    if (value !== undefined) return value;

    if (Date.now() - started > timeoutMs)
      throw new Error(`Timed out waiting for ${what}`);

    await new Promise((done) => setTimeout(done, 20));
  }
}

interface Harness {
  readonly url: string;
  readonly activity: ActivityLog;
  /** A session cookie, as the inspector page holds. */
  readonly cookie: string;
  get(path: string): Promise<Response>;
  run(body: unknown, headers?: Record<string, string>): Promise<Response>;
}

/** The dev server with the playground and a running runtime host for `noteApp`. */
async function createHarness(): Promise<Harness> {
  const root = await mkdtemp(join(tmpdir(), 'relate-playground-test-'));

  cleanups.push(() => rm(root, { recursive: true, force: true }));
  await symlink(join(repoRoot, 'node_modules'), join(root, 'node_modules'));

  const statuses: RuntimeStatus[] = [];
  const activity = createActivityLog();
  const controller = createRuntimeController({
    activity,
    projectRoot: root,
    configPath: join(root, 'relate.config.ts'),
    env: process.env,
    onStatus: (status) => statuses.push(status),
    writeStdout: () => {},
    writeStderr: () => {},
  });

  cleanups.push(() => controller.stop());

  const playground = createPlayground({
    runtime: controller,
    principals: () => ({ names: ['alice', 'bob'] }),
    activity,
  });
  let app: { fetch(request: Request): Response | Promise<Response> } | null =
    null;
  const server = createAdaptorServer({
    fetch: (request) => app!.fetch(request),
  }) as Server;

  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  cleanups.push(() => new Promise<void>((done) => server.close(() => done())));

  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const sessions = createSessions({
    instanceId: 'test-instance',
    allowedOrigins: [url],
  });
  const dev = createDevServer({
    supervisor: new Supervisor('test-instance'),
    sessions,
    ownerId: 'test-owner',
    activity,
    playground,
  });

  app = dev.app;
  cleanups.push(async () => dev.closeStreams());

  const bundle = join(root, 'build-1.mjs');

  await writeFile(bundle, noteApp());
  await controller.restart({
    generation: 1,
    bundle: { path: bundle, release: async () => {} },
  });
  await waitUntil(
    () => statuses.find((s) => s.state === 'running'),
    'the runtime to start',
  );

  const exchanged = await fetch(`${url}/dev/session`, {
    method: 'POST',
    headers: { origin: url, 'content-type': 'application/json' },
    body: JSON.stringify({ token: sessions.token }),
  });

  expect(exchanged.status).toBe(204);

  const cookie = (exchanged.headers.get('set-cookie') ?? '').split(';')[0]!;

  return {
    url,
    activity,
    cookie,
    get: (path) => fetch(`${url}${path}`, { headers: { cookie } }),
    run: (body, headers = {}) =>
      fetch(`${url}/dev/playground/runs`, {
        method: 'POST',
        headers: {
          cookie,
          origin: url,
          'content-type': 'application/json',
          ...headers,
        },
        body: JSON.stringify(body),
      }),
  };
}

async function runOf(response: Response): Promise<PlaygroundRun> {
  expect(response.status).toBe(200);

  return playgroundRunSchema.parse(await response.json());
}

it("returns each principal's own discovery", async () => {
  const harness = await createHarness();

  const alice = playgroundDiscoverySchema.parse(
    await (await harness.get('/dev/playground/discovery?as=alice')).json(),
  );
  const bob = playgroundDiscoverySchema.parse(
    await (await harness.get('/dev/playground/discovery?as=bob')).json(),
  );
  const unknown = await harness.get('/dev/playground/discovery?as=mallory');

  expect(Object.keys(alice.objects)).toEqual(['Note']);
  expect(alice.objects.Note).toMatchObject({
    apiName: 'Note',
    description: 'A short note.',
    properties: [{ name: 'body', schema: { type: 'string' } }, { name: 'id' }],
  });
  expect(alice.overview.sdk?.options).toHaveProperty('select');
  expect(bob.objects).toEqual({});
  expect(unknown.status).toBe(404);
});

it('runs code as the principal and records it as a playground call', async () => {
  const harness = await createHarness();

  const run = await runOf(
    await harness.run({
      principal: 'alice',
      code: `const page = await graph.objects.Note.query({ select: ['body'] });
console.log('notes', page.data.length);
return page;`,
    }),
  );

  expect(run).toMatchObject({
    status: 'succeeded',
    principal: 'alice',
    result: { data: [], meta: { exhausted: true } },
    logs: [{ stream: 'stdout', text: 'notes 0\n' }],
    reads: [{ object: 'Note', operation: 'query' }],
    errors: [],
  });

  const events = harness.activity.snapshot();
  const of = <K extends ActivityEvent['kind']>(kind: K) =>
    events.filter(
      (event): event is Extract<ActivityEvent, { kind: K }> =>
        event.kind === kind,
    );

  expect(of('call')).toMatchObject([
    {
      requestId: run.requestId,
      source: 'inspector-playground',
      tool: 'execute',
      principal: 'alice',
      status: 'succeeded',
    },
  ]);
  expect(of('execution')).toMatchObject([
    { requestId: run.requestId, status: 'succeeded' },
  ]);
  expect(of('operation')).toMatchObject([
    { op: 'query', context: { requestId: run.requestId } },
  ]);
});

it('captures the request issues of a failed read, even when the code catches it', async () => {
  const harness = await createHarness();

  const uncaught = await runOf(
    await harness.run({
      principal: 'alice',
      code: `return graph.objects.Note.query({ where: { title: 'Call' } });`,
    }),
  );
  const caught = await runOf(
    await harness.run({
      principal: 'alice',
      code: `try {
  await graph.objects.Note.query({ bogus: 1 });
} catch {
  return 'handled';
}`,
    }),
  );

  expect(uncaught).toMatchObject({
    status: 'failed',
    error: { name: 'ReadError', code: 'invalid-request' },
    errors: [
      {
        operation: 'Note.query',
        code: 'invalid-request',
        issues: [{ path: ['where', 'title'], problem: 'unknown-property' }],
      },
    ],
  });
  expect(caught).toMatchObject({
    status: 'succeeded',
    result: 'handled',
    errors: [
      {
        code: 'invalid-request',
        issues: [{ path: ['bogus'], problem: 'unknown-option' }],
      },
    ],
  });
});

it('refuses runs that do not come from the inspector page', async () => {
  const harness = await createHarness();

  const crossSite = await harness.run(
    { principal: 'alice', code: 'return 1;' },
    { origin: 'https://example.test' },
  );
  const unknown = await harness.run({
    principal: 'mallory',
    code: 'return 1;',
  });
  const empty = await harness.run({ principal: 'alice', code: '   ' });

  expect(crossSite.status).toBe(403);
  expect(unknown.status).toBe(404);
  expect(empty.status).toBe(400);
  expect(harness.activity.snapshot()).toEqual([]);
});
