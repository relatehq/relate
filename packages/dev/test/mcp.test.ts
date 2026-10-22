/**
 * `/mcp` and activity observation: an MCP client over real HTTP against the
 * dev server, backed by a real runtime host started from the built CLI. Each
 * test writes its own application module.
 */
import {
  mkdtemp,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { request as httpRequest } from 'node:http';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createAdaptorServer } from '@hono/node-server';
import {
  Client,
  StreamableHTTPClientTransport,
} from '@modelcontextprotocol/client';
import { afterEach, expect, it } from 'vitest';
import {
  Supervisor,
  createActivityLog,
  createDevServer,
  createMcpEndpoint,
  createMcpToken,
  readMcpToken,
  createRuntimeController,
  createSessions,
} from '@relate/dev';
import type { ActivityLog, RuntimeController } from '@relate/dev';
import { activityEventSchema } from '@relate/inspector/protocol';
import type {
  ActivityEvent,
  CallEvent,
  ExecutionEvent,
  OperationEvent,
  RuntimeStatus,
} from '@relate/inspector/protocol';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

/** A native Note object, an action that creates one and two principals. */
function noteApp(options: { implementation?: string } = {}) {
  return `import { z } from 'zod';
import {
  defineAccess, defineAction, defineApp, defineGraph, defineObject,
  implementAction, native, nativeMembership, objectId,
} from 'relate';

const access = defineAccess({
  roles: ['reader', 'writer'],
  fieldGroups: ['ordinary'],
  claims: {},
});
const Note = defineObject({
  id: 'notes.note',
  membership: nativeMembership(),
  properties: {
    id: objectId({ id: 'note.id' }),
    body: native(z.string(), { id: 'note.body' }),
  },
});
const AddNote = defineAction({
  id: 'notes.add',
  input: z.object({ body: z.string() }),
  output: z.object({ ok: z.boolean() }),
  creates: [Note],
  policy: { execute: access.role('writer') },
});
export const graph = defineGraph({
  id: 'notes',
  objects: { Note },
  actions: { addNote: AddNote },
  access,
  policies: {
    Note: {
      read: { gate: access.role('reader') },
      create: { gate: access.role('writer') },
    },
  },
  principals: {
    alice: { roles: ['reader', 'writer'] },
    bob: { roles: [] },
  },
});
const addNote = implementAction(graph, AddNote, ${
    options.implementation ??
    `async ({ input, objects }) => {
  await objects.Note.create({ body: input.body });

  return { ok: true };
}`
  });

export default defineApp({
  graph,
  setup: () => ({ bindings: [], actionImplementations: [addNote] }),
});
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
  readonly token: string;
  readonly activity: ActivityLog;
  readonly controller: RuntimeController;
  readonly statuses: RuntimeStatus[];
  /** Write and start a build of `source` as the next generation. */
  start(source: string): Promise<RuntimeStatus>;
  connect(path?: string): Promise<Client>;
  /** A session cookie, as the inspector would hold. */
  session(): Promise<string>;
}

/** The dev server's HTTP surface with `/mcp`, over a real loopback listener. */
async function createHarness(
  options: {
    runtime?: boolean;
    drainTimeoutMs?: number;
    /** The accepted model's principals; may be ahead of the running runtime. */
    principals?: readonly string[];
  } = {},
): Promise<Harness> {
  const root = await mkdtemp(join(tmpdir(), 'relate-mcp-test-'));

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
    ...(options.drainTimeoutMs !== undefined
      ? { drainTimeoutMs: options.drainTimeoutMs }
      : {}),
  });

  cleanups.push(() => controller.stop());

  const names = options.principals ?? ['alice', 'bob'];
  const mcp = createMcpEndpoint({
    token: createMcpToken(),
    runtime: options.runtime === false ? null : controller,
    principals: () => ({ names, defaultPrincipal: names[0] ?? null }),
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
    mcp: mcp.handle,
  });

  app = dev.app;
  cleanups.push(async () => dev.closeStreams());
  let generation = 0;

  return {
    url,
    token: mcp.token,
    activity,
    controller,
    statuses,
    async start(source) {
      generation += 1;
      const path = join(root, `build-${generation}.mjs`);
      const expected = generation;

      await writeFile(path, source);
      await controller.restart({
        generation,
        bundle: { path, release: async () => {} },
      });

      return waitUntil(
        () =>
          statuses.find(
            (s) => s.generation === expected && s.state === 'running',
          ),
        `runtime generation ${expected}`,
      );
    },
    async connect(path = '/mcp') {
      const client = new Client({ name: 'mcp-test', version: '1' });

      await client.connect(
        new StreamableHTTPClientTransport(new URL(path, url), {
          requestInit: { headers: { authorization: `Bearer ${mcp.token}` } },
        }),
      );
      cleanups.push(() => client.close());

      return client;
    },
    async session() {
      const response = await fetch(`${url}/dev/session`, {
        method: 'POST',
        headers: { origin: url, 'content-type': 'application/json' },
        body: JSON.stringify({ token: sessions.token }),
      });

      expect(response.status).toBe(204);

      return (response.headers.get('set-cookie') ?? '').split(';')[0]!;
    },
  };
}

const ofKind = <K extends ActivityEvent['kind']>(
  events: readonly ActivityEvent[],
  kind: K,
) =>
  events.filter(
    (event): event is Extract<ActivityEvent, { kind: K }> =>
      event.kind === kind,
  );

it('runs discover and execute over HTTP against the runtime host and links request → execution → operations', async () => {
  const harness = await createHarness();
  const running = await harness.start(noteApp());
  const client = await harness.connect();

  const discovery = await client.callTool({ name: 'discover', arguments: {} });
  const execution = await client.callTool({
    name: 'execute',
    arguments: {
      code: `const receipt = await graph.actions.addNote({ input: { body: 'Call the customer' }, idempotencyKey: 'first' });
const page = await graph.objects.Note.query({ limit: 10 });
console.log('notes', page.data.length);
return { state: receipt.state, notes: page.data.length };`,
    },
  });

  expect(discovery.isError).toBeFalsy();
  expect(discovery.structuredContent).toMatchObject({
    graph: { objects: { Note: {} }, actions: { addNote: {} } },
  });
  expect(execution.structuredContent).toMatchObject({
    status: 'succeeded',
    result: { state: 'succeeded', notes: 1 },
  });

  // The runtime's own records arrive after the call; wait for the last one.
  await waitUntil(
    () =>
      ofKind(harness.activity.snapshot(), 'operation').find(
        (event) => event.op === 'query' && event.runtime,
      ),
    'the runtime record of the query',
  );

  const events = harness.activity.snapshot();
  const calls = ofKind(events, 'call');
  const [executed] = ofKind(events, 'execution');
  // Runtime records arrive asynchronously; compare in a fixed order.
  const order = ['invoke', 'query', 'created', 'invocation-succeeded'];
  const operations = ofKind(events, 'operation').sort(
    (a, b) => order.indexOf(a.op) - order.indexOf(b.op),
  );

  expect(calls).toMatchObject([
    {
      tool: 'discover',
      status: 'succeeded',
      principal: 'alice',
      source: 'external',
      runtimeId: running.runtimeId,
    },
    { tool: 'execute', status: 'succeeded', runtimeId: running.runtimeId },
  ]);
  expect(executed).toMatchObject({
    requestId: calls[1]!.requestId,
    runtimeId: running.runtimeId,
    principal: 'alice',
    status: 'succeeded',
    code: expect.stringContaining('graph.actions.addNote'),
    logs: [{ stream: 'stdout', text: 'notes 1\n' }],
    resultPreview: '{"state":"succeeded","notes":1}',
  });
  const context = {
    requestId: calls[1]!.requestId,
    executionId: executed!.executionId,
    runtimeId: running.runtimeId,
    definitionRevision: running.definitionRevision,
    principal: 'alice',
    transport: 'mcp',
  };

  // Each call's dispatch event (request previews) carries the runtime's own
  // record (authoritative outcome) under the same operation ID; the committed
  // feed entries of the invocation join the same request.
  expect(operations).toMatchObject([
    {
      op: 'invoke',
      definitionId: 'notes.add',
      context,
      status: 'succeeded',
      request: {
        idempotencyKey: 'first',
        input: '{"body":"Call the customer"}',
      },
      outcome: { receiptState: 'succeeded', invocationId: expect.any(String) },
      runtime: {
        record: 'attempt',
        actor: { kind: 'principal', id: 'alice' },
        outcome: 'succeeded',
      },
    },
    {
      op: 'query',
      definitionId: 'notes.note',
      context,
      status: 'succeeded',
      request: { limit: 10 },
      outcome: { records: 1, hasMore: false },
      recordIds: [expect.any(String)],
      runtime: { record: 'attempt', outcome: 'ok' },
    },
    {
      op: 'created',
      definitionId: 'notes.note',
      context,
      status: 'succeeded',
      recordIds: [operations[1]!.recordIds[0]],
      runtime: { record: 'committed', position: expect.any(String) },
    },
    {
      op: 'invocation-succeeded',
      definitionId: 'notes.add',
      context,
      outcome: {
        receiptState: 'succeeded',
        invocationId: operations[0]!.outcome!.invocationId,
      },
      runtime: { record: 'committed' },
    },
  ]);

  // Every event of the request is one the inspector accepts.
  for (const event of events)
    expect(activityEventSchema.safeParse(event).success).toBe(true);

  // Read results keep IDs and counts, never record values.
  expect(JSON.stringify(operations.slice(1))).not.toContain(
    'Call the customer',
  );
}, 60_000);

it('serves the activity log to inspector sessions only, as a snapshot and a stream', async () => {
  const harness = await createHarness();

  await harness.start(noteApp());
  const client = await harness.connect('/mcp?as=bob');
  const cookie = await harness.session();

  expect((await fetch(`${harness.url}/dev/activity`)).status).toBe(401);

  // A stream opened before the call receives its events as they happen.
  const stream = await fetch(`${harness.url}/dev/activity`, {
    headers: { cookie, accept: 'text/event-stream' },
  });
  const reader = stream.body!.getReader();
  const decoder = new TextDecoder();
  let text = '';
  const read = async (pattern: RegExp) => {
    while (!pattern.test(text)) {
      const { value, done } = await reader.read();

      if (done) throw new Error('Activity stream ended');

      text += decoder.decode(value, { stream: true });
    }
  };

  cleanups.push(() => reader.cancel().catch(() => undefined));
  await read(/"type":"snapshot"/);
  await client.callTool({ name: 'discover', arguments: {} });
  await read(/"status":"succeeded"/);

  const snapshot = await fetch(`${harness.url}/dev/activity`, {
    headers: { cookie },
  });

  expect(snapshot.headers.get('cache-control')).toBe('no-store');
  expect(await snapshot.json()).toMatchObject({
    type: 'snapshot',
    events: [{ kind: 'call', tool: 'discover', principal: 'bob' }],
  });
  expect(text).toContain('"type":"event"');
  expect(text).toContain('"principal":"bob"');
}, 60_000);

it('rejects a missing or wrong token, a browser Origin, a foreign Host and an undeclared principal', async () => {
  const harness = await createHarness();
  const cookie = await harness.session();
  const initialize = JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2025-11-25',
      capabilities: {},
      clientInfo: { name: 'probe', version: '1' },
    },
  });
  const post = (path: string, headers: Record<string, string>) =>
    fetch(`${harness.url}${path}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        ...headers,
      },
      body: initialize,
    });
  const bearer = { authorization: `Bearer ${harness.token}` };

  const missing = await post('/mcp', {});
  const wrong = await post('/mcp', { authorization: 'Bearer not-the-token' });
  // The inspector's session does not grant MCP access.
  const sessionOnly = await post('/mcp', { cookie });
  // Not even the inspector's own origin: MCP clients are not browsers.
  const browser = await post('/mcp', { ...bearer, origin: harness.url });
  // fetch does not let a caller set Host; a DNS-rebinding page's request does.
  const foreignHost = await new Promise<number>((done, fail) => {
    const target = new URL(harness.url);
    const request = httpRequest(
      {
        host: target.hostname,
        port: target.port,
        path: '/mcp',
        method: 'POST',
        headers: {
          ...bearer,
          host: 'evil.test',
          'content-type': 'application/json',
        },
      },
      (response) => {
        response.resume();
        done(response.statusCode ?? 0);
      },
    );

    request.on('error', fail);
    request.end(initialize);
  });
  const undeclared = await post('/mcp?as=mallory', bearer);
  const accepted = await post('/mcp?as=bob', bearer);

  expect(missing.status).toBe(401);
  expect(missing.headers.get('www-authenticate')).toContain('Bearer');
  expect(wrong.status).toBe(401);
  expect(sessionOnly.status).toBe(401);
  expect(browser.status).toBe(403);
  expect(foreignHost).toBe(403);
  expect(undeclared.status).toBe(404);
  expect(await undeclared.json()).toEqual({
    error: "Unknown development principal 'mallory'. Declared: alice, bob",
  });
  expect(accepted.status).toBe(200);
  // Rejected requests are not activity.
  expect(harness.activity.snapshot()).toEqual([]);
}, 30_000);

it("returns the runtime's reason as a tool error at once when it cannot serve the call", async () => {
  const harness = await createHarness();
  const off = await createHarness({ runtime: false });
  const client = await harness.connect();
  const offClient = await off.connect();

  const started = Date.now();
  const discover = await client.callTool({ name: 'discover', arguments: {} });
  const execute = await offClient.callTool({
    name: 'execute',
    arguments: { code: 'return 1;' },
  });

  expect(Date.now() - started).toBeLessThan(5_000);
  expect(discover).toMatchObject({
    isError: true,
    structuredContent: {
      error: {
        code: 'binding-unavailable',
        message: 'The runtime has not started yet; retry shortly',
        retryable: true,
      },
    },
  });
  expect(execute).toMatchObject({
    isError: true,
    structuredContent: {
      status: 'failed',
      error: {
        code: 'binding-unavailable',
        message: 'The runtime is off (relate dev --no-runtime)',
        retryable: false,
      },
    },
  });
  expect(harness.activity.snapshot()).toMatchObject([
    {
      kind: 'call',
      tool: 'discover',
      status: 'failed',
      runtimeId: null,
      principal: 'alice',
      error: 'The runtime has not started yet; retry shortly',
    },
  ]);
  expect(off.activity.snapshot()).toMatchObject([
    {
      kind: 'call',
      status: 'failed',
      error: 'The runtime is off (relate dev --no-runtime)',
    },
  ]);
}, 30_000);

it('explains a principal the model declares but the running runtime predates', async () => {
  // The model now declares carol; the runtime started before she was added.
  const harness = await createHarness({
    principals: ['alice', 'bob', 'carol'],
  });

  await harness.start(noteApp());
  const client = await harness.connect('/mcp?as=carol');
  const discover = await client.callTool({ name: 'discover', arguments: {} });

  expect(discover.structuredContent).toEqual({
    error: {
      code: 'binding-unavailable',
      message:
        "The running runtime (gen 1) does not declare principal 'carol'; it serves alice, bob. It restarts with the next accepted build.",
      retryable: true,
    },
  });
  expect(harness.activity.snapshot()).toMatchObject([
    {
      kind: 'call',
      principal: 'carol',
      error: expect.stringContaining("'carol'"),
    },
  ]);
}, 30_000);

it('bounds every caller-controlled string and records only finite limits', async () => {
  const harness = await createHarness();

  await harness.start(noteApp());
  const client = await harness.connect();

  await client.callTool({
    name: 'execute',
    arguments: {
      code: `const results = [];
for (const call of [
  () => graph.objects.Note.query({ limit: NaN }),
  () => graph.objects.Note.get('x'.repeat(600000)),
  () => graph.objects.Note.query({ cursor: 'c'.repeat(600000), select: ['s'.repeat(600000)] }),
  () => graph.actions.addNote({ input: { body: 'b'.repeat(600000) }, idempotencyKey: 'k'.repeat(600000) }),
]) {
  try { await call(); results.push('ok'); } catch (error) { results.push(error.code); }
}
return results;`,
    },
  });

  // Check the bounds once the runtime's records have arrived too: the two
  // queries and the invoke, plus the invocation's committed feed entries.
  await waitUntil(() => {
    const events = ofKind(harness.activity.snapshot(), 'operation');

    return events.filter((e) => e.runtime).length === 5 ? events : undefined;
  }, 'the runtime records');

  const operations = ofKind(harness.activity.snapshot(), 'operation');
  const sizes = harness.activity
    .snapshot()
    .map((event) => JSON.stringify(event).length);

  expect(operations.map((e) => [e.op, e.runtime?.outcome])).toEqual([
    ['query', 'rejected'],
    // Its 600,000-character target exceeds the runtime's per-row cap, so the
    // runtime drops the row (and counts it); the dispatch event remains.
    ['get', undefined],
    ['query', 'rejected'],
    ['invoke', 'succeeded'],
    ['created', undefined],
    ['invocation-succeeded', undefined],
  ]);
  expect(operations[0]!.request).not.toHaveProperty('limit');
  expect(operations[0]!.outcome?.error?.code).toBe('invalid-request');
  expect(operations[1]!.request.objectId).toMatch(
    /^x{256}… \(599744 more characters\)$/,
  );
  expect(operations[2]!.request.cursor!.length).toBeLessThan(300);
  expect(operations[2]!.request.select![0]!.length).toBeLessThan(300);
  expect(operations[3]!.request.idempotencyKey!.length).toBeLessThan(300);
  expect(operations[3]!.request.input!.length).toBeLessThan(1_100);
  expect(Math.max(...sizes)).toBeLessThan(64 * 1024);

  // Every recorded event is one the inspector accepts.
  for (const event of harness.activity.snapshot())
    expect(activityEventSchema.safeParse(event).success).toBe(true);
}, 30_000);

it('keeps the project token across restarts, rotates it on request and keeps it out of git', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'relate-mcp-token-'));

  cleanups.push(() => rm(directory, { recursive: true, force: true }));

  const first = await readMcpToken(directory);
  const again = await readMcpToken(directory);
  const rotated = await readMcpToken(directory, { rotate: true });

  await writeFile(join(directory, 'mcp-token'), 'tampered');
  const replaced = await readMcpToken(directory);

  expect(first).toMatchObject({
    created: true,
    token: expect.stringMatching(/^[\w-]{43}$/),
  });
  expect(again).toEqual({ token: first.token, created: false });
  expect(rotated.created).toBe(true);
  expect(rotated.token).not.toBe(first.token);
  expect(replaced.created).toBe(true);
  expect(replaced.token).not.toBe('tampered');
  expect(await readFile(join(directory, '.gitignore'), 'utf8')).toBe('*\n');

  if (process.platform !== 'win32')
    expect((await stat(join(directory, 'mcp-token'))).mode & 0o777).toBe(0o600);
});

it('fails an execution that outlives its runtime with runtime-retired instead of rebinding it', async () => {
  const harness = await createHarness();
  const first = await harness.start(noteApp());
  const client = await harness.connect();
  const result = client.callTool({
    name: 'execute',
    arguments: {
      code: `await graph.objects.Note.query({ limit: 1 });
for (let i = 0; i < 200; i += 1) {
  await new Promise((done) => setTimeout(done, 25));
  try {
    await graph.objects.Note.query({ limit: 1 });
  } catch (error) {
    return { name: error.name, code: error.code };
  }
}
return { code: 'never retired' };`,
    },
  });

  // Restart once the execution has read from the first runtime.
  await waitUntil(
    () =>
      ofKind(harness.activity.snapshot(), 'operation').find(
        (op) => op.status === 'succeeded',
      ),
    'a first read',
  );
  const second = await harness.start(noteApp());

  expect((await result).structuredContent).toMatchObject({
    status: 'succeeded',
    result: { name: 'ReadError', code: 'runtime-retired' },
  });

  const operations = ofKind(harness.activity.snapshot(), 'operation');

  // Every operation of the execution stayed pinned to the first runtime.
  expect(new Set(operations.map((op) => op.context.runtimeId))).toEqual(
    new Set([first.runtimeId]),
  );
  expect(operations.at(-1)).toMatchObject({
    status: 'failed',
    outcome: { error: { code: 'runtime-retired' } },
  });

  // The next request binds to the new runtime.
  await client.callTool({ name: 'discover', arguments: {} });
  expect(ofKind(harness.activity.snapshot(), 'call').at(-1)).toMatchObject({
    tool: 'discover',
    runtimeId: second.runtimeId,
  });
  expect(second.runtimeId).not.toBe(first.runtimeId);
}, 60_000);

it('shows an action cut off by a restart as uncertain, and never replays it', async () => {
  const harness = await createHarness({ drainTimeoutMs: 200 });

  await harness.start(
    noteApp({ implementation: '() => new Promise(() => {})' }),
  );
  const client = await harness.connect();
  const result = client.callTool({
    name: 'execute',
    arguments: {
      code: `try {
  await graph.actions.addNote({ input: { body: 'Never finishes' }, idempotencyKey: 'stuck' });
} catch (error) {
  return { code: error.code };
}`,
    },
  });
  const invoke = await waitUntil(
    () =>
      ofKind(harness.activity.snapshot(), 'operation').find(
        (op) => op.op === 'invoke',
      ),
    'the invocation',
  );

  expect(invoke.status).toBe('running');
  await harness.start(noteApp());

  expect((await result).structuredContent).toMatchObject({
    status: 'succeeded',
    result: { code: 'uncertain' },
  });
  const operations: OperationEvent[] = ofKind(
    harness.activity.snapshot(),
    'operation',
  );

  expect(operations).toHaveLength(1);
  expect(operations[0]).toMatchObject({
    opId: invoke.opId,
    status: 'failed',
    outcome: { error: { code: 'uncertain' } },
  });
}, 60_000);

it('bounds the activity log by finished request and never cuts a running one short', () => {
  const log = createActivityLog({ requests: 2, operationsPerRequest: 1 });
  const call = (
    requestId: string,
    status: CallEvent['status'] = 'running',
  ): CallEvent => ({
    kind: 'call',
    requestId,
    runtimeId: 'runtime-1',
    source: 'external',
    principal: 'alice',
    tool: 'execute',
    at: new Date(0).toISOString(),
    status,
  });
  const execution: ExecutionEvent = {
    kind: 'execution',
    executionId: 'execution-a',
    requestId: 'a',
    runtimeId: 'runtime-1',
    principal: 'alice',
    at: new Date(0).toISOString(),
    code: 'return 1;',
    codeTruncated: false,
    status: 'running',
    logs: [],
    logsTruncated: false,
  };
  const operation = (requestId: string, opId: string): OperationEvent => ({
    kind: 'operation',
    opId,
    context: {
      requestId,
      runtimeId: 'runtime-1',
      definitionRevision: 'rev',
      principal: 'alice',
      transport: 'mcp',
    },
    at: new Date(0).toISOString(),
    op: 'query',
    definitionId: 'notes.note',
    request: {},
    status: 'running',
    recordIds: [],
  });
  const kinds = () =>
    log
      .snapshot()
      .map((event) => [
        event.kind,
        (event as { requestId?: string }).requestId ?? 'op',
        event.status,
      ]);

  log.record(call('a'));
  log.record(execution);
  log.record(call('b'));
  log.record(operation('b', 'op-1'));
  // Over the per-request operation limit: not recorded.
  log.record(operation('b', 'op-2'));
  log.record({ ...operation('b', 'op-1'), status: 'succeeded', ms: 1 });
  log.record({ ...call('b'), status: 'succeeded', ms: 1 });
  // A third request: a is still running, so the oldest finished one (b) goes.
  log.record(call('c'));

  expect(kinds()).toEqual([
    ['call', 'a', 'running'],
    ['execution', 'a', 'running'],
    ['call', 'c', 'running'],
  ]);

  // A late operation of the evicted request does not start an orphan entry.
  log.record(operation('b', 'op-3'));
  // Once a finishes, it is evicted like any other.
  log.record({ ...execution, status: 'succeeded', ms: 1 });
  log.record({ ...call('a'), status: 'succeeded', ms: 1 });
  log.record(call('d'));

  expect(kinds()).toEqual([
    ['call', 'c', 'running'],
    ['call', 'd', 'running'],
  ]);
});
