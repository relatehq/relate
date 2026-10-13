/**
 * The built-in agent: the loop against a fake Anthropic client, the
 * `/dev/agent/*` routes, and one end-to-end run through the real `/mcp` and a
 * real runtime host. No test reaches the network.
 */
import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createAdaptorServer } from '@hono/node-server';
import type { CallToolResult, Tool } from '@modelcontextprotocol/client';
import { afterEach, expect, it, vi } from 'vitest';
import {
  AgentRequestError,
  RuntimeUnavailableError,
  Supervisor,
  agentEffort,
  agentModel,
  agentSetup,
  connectLoopbackMcp,
  createActivityLog,
  createAgent,
  createDevServer,
  createMcpEndpoint,
  createMcpToken,
  createRuntimeController,
  createSessions,
  toAnthropicTools,
} from '@relate/cli';
import type {
  Agent,
  AgentModelClient,
  AgentStreamParams,
  ConnectAgentTools,
} from '@relate/cli';
import {
  agentEventSchema,
  agentSnapshotSchema,
  agentTurnAcceptedSchema,
} from '@relate/inspector/protocol';
import type {
  AgentConversation,
  AgentEvent,
  AgentToolMessage,
  CallEvent,
  ExecutionEvent,
  RuntimeStatus,
} from '@relate/inspector/protocol';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();

  vi.unstubAllEnvs();
});

type Message = Awaited<
  ReturnType<
    ReturnType<AgentModelClient['beta']['messages']['stream']>['finalMessage']
  >
>;

type Block =
  | { readonly type: 'text'; readonly text: string }
  | {
      readonly type: 'tool_use';
      readonly id: string;
      readonly name: string;
      readonly input: unknown;
    };

let messages = 0;

/** A model response; `tool_use` when it calls a tool, `end_turn` otherwise. */
function reply(
  content: readonly Block[],
  options: {
    stop_reason?: string;
    stop_details?: { type: 'refusal'; category: string | null } | null;
  } = {},
): Message {
  messages += 1;

  return {
    id: `msg_${messages}`,
    type: 'message',
    role: 'assistant',
    model: agentModel,
    content: content.map((block) =>
      block.type === 'text' ? { ...block, citations: null } : block,
    ),
    stop_reason:
      options.stop_reason ??
      (content.some((block) => block.type === 'tool_use')
        ? 'tool_use'
        : 'end_turn'),
    stop_details: options.stop_details ?? null,
    stop_sequence: null,
    container: null,
    context_management: null,
    usage: { input_tokens: 1, output_tokens: 1 },
  } as unknown as Message;
}

const toolUse = (id: string, name: string, input: unknown): Block => ({
  type: 'tool_use',
  id,
  name,
  input,
});

type Step = (
  request: AgentStreamParams,
  signal: AbortSignal,
) => Message | Promise<Message>;

/** Rejects when `signal` aborts, as the SDK's stream does. */
function abortable<T>(value: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(new Error('Request was aborted.'));

    if (signal.aborted) return abort();

    signal.addEventListener('abort', abort, { once: true });
    value.then(resolve, reject);
  });
}

/**
 * A fake `@anthropic-ai/sdk` client: each `stream` call takes the next step,
 * emits its text as stream events and resolves `finalMessage`. Requests are
 * recorded as sent.
 */
function fakeModel(steps: Step[]) {
  const requests: AgentStreamParams[] = [];
  const client: AgentModelClient = {
    beta: {
      messages: {
        stream(params, { signal }) {
          requests.push(structuredClone(params));

          const step = steps.shift();
          const listeners: ((event: never) => void)[] = [];
          const final = abortable(
            Promise.resolve().then(() => {
              if (!step) throw new Error('The fake model has no response left');

              return step(params, signal);
            }),
            signal,
          ).then((message) => {
            message.content.forEach((block, index) => {
              const start =
                block.type === 'text' ? { ...block, text: '' } : block;

              for (const listener of listeners)
                listener({
                  type: 'content_block_start',
                  index,
                  content_block: start,
                } as never);

              if (block.type === 'text')
                for (const listener of listeners)
                  listener({
                    type: 'content_block_delta',
                    index,
                    delta: { type: 'text_delta', text: block.text },
                  } as never);
            });

            return message;
          });

          final.catch(() => {});

          return {
            on(_event, listener) {
              listeners.push(listener as (event: never) => void);

              return this;
            },
            finalMessage: () => final,
          };
        },
      },
    },
  };

  return { client, requests };
}

/** The two `@relate/mcp` tools as an MCP server lists them. */
function mcpTools(): Tool[] {
  return [
    {
      name: 'discover',
      description: 'Discover actor-visible graph metadata.',
      inputSchema: {
        $schema: 'https://json-schema.org/draft/2020-12/schema',
        type: 'object',
        properties: {},
        additionalProperties: false,
      },
    },
    {
      name: 'execute',
      description: 'Run an async JavaScript function body with graph injected.',
      inputSchema: {
        $schema: 'https://json-schema.org/draft/2020-12/schema',
        type: 'object',
        properties: { code: { type: 'string', minLength: 1 } },
        required: ['code'],
        additionalProperties: false,
      },
    },
  ];
}

const textResult = (value: unknown, isError = false): CallToolResult => ({
  content: [{ type: 'text', text: JSON.stringify(value) }],
  structuredContent: value as Record<string, unknown>,
  ...(isError ? { isError: true } : {}),
});

interface RecordedCall {
  readonly principal: string;
  readonly name: string;
  readonly arguments: Record<string, unknown>;
  readonly requestId: string;
}

/** A fake MCP session per principal; `handle` answers each tool call. */
function fakeTools(
  handle: (
    call: RecordedCall,
    signal: AbortSignal,
  ) => CallToolResult | Promise<CallToolResult> = () =>
    textResult({ status: 'succeeded', result: null }),
) {
  const connections: string[] = [];
  const calls: RecordedCall[] = [];
  const connect: ConnectAgentTools = async (principal) => {
    connections.push(principal);

    return {
      instructions: 'Call discover first.',
      tools: mcpTools(),
      async callTool(call, signal) {
        const recorded = { principal, ...call };

        calls.push(recorded);

        return abortable(Promise.resolve(handle(recorded, signal)), signal);
      },
      close: async () => {},
    };
  };

  return { connect, connections, calls };
}

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });

  return { promise, resolve };
}

async function waitUntil<T>(
  read: () => T | undefined | false,
  what: string,
  timeoutMs = 10_000,
): Promise<T> {
  const started = Date.now();

  for (;;) {
    const value = read();

    if (value !== undefined && value !== false) return value;

    if (Date.now() - started > timeoutMs)
      throw new Error(`Timed out waiting for ${what}`);

    await new Promise((done) => setTimeout(done, 10));
  }
}

const conversationOf = (agent: Agent, principal: string) =>
  agent.snapshot().conversations.find((entry) => entry.principal === principal);

/** Wait for `principal`'s turn to end and return its conversation. */
const settled = (agent: Agent, principal: string) =>
  waitUntil(() => {
    const conversation = conversationOf(agent, principal);

    return conversation && conversation.turn === null
      ? conversation
      : undefined;
  }, `${principal}'s turn to end`);

const toolMessages = (conversation: AgentConversation) =>
  conversation.messages.filter(
    (message): message is AgentToolMessage => message.kind === 'tool',
  );

function createTestAgent(options: {
  steps: Step[];
  tools?: ReturnType<typeof fakeTools>;
  principals?: readonly string[];
  env?: NodeJS.ProcessEnv;
}) {
  const model = fakeModel(options.steps);
  const tools = options.tools ?? fakeTools();
  const names = options.principals ?? ['alice', 'bob'];
  const agent = createAgent({
    env: options.env ?? { ANTHROPIC_API_KEY: 'sk-ant-test-key' },
    principals: () => ({ names }),
    connect: tools.connect,
    createClient: () => model.client,
  });

  cleanups.push(() => agent.stop());

  return { agent, model, tools };
}

it('maps MCP tools to Anthropic tools field by field', () => {
  const tools = toAnthropicTools(mcpTools());

  expect(tools).toEqual([
    {
      name: 'discover',
      description: 'Discover actor-visible graph metadata.',
      input_schema: {
        type: 'object',
        properties: {},
        additionalProperties: false,
      },
    },
    {
      name: 'execute',
      description: 'Run an async JavaScript function body with graph injected.',
      input_schema: {
        type: 'object',
        properties: { code: { type: 'string', minLength: 1 } },
        required: ['code'],
        additionalProperties: false,
      },
    },
  ]);
});

it('streams each response with the pinned model, explicit effort and the mapped tools', async () => {
  const { agent, model } = createTestAgent({
    steps: [() => reply([{ type: 'text', text: 'The graph has notes.' }])],
  });

  agent.send('alice', 'What is in the graph?');
  const conversation = await settled(agent, 'alice');

  expect(model.requests).toHaveLength(1);
  expect(model.requests[0]).toMatchObject({
    model: 'claude-opus-5-5',
    output_config: { effort: agentEffort },
    thinking: { type: 'adaptive' },
    tools: toAnthropicTools(mcpTools()),
    messages: [{ role: 'user', content: 'What is in the graph?' }],
  });
  expect(model.requests[0]!.system).toContain('"alice"');
  expect(model.requests[0]!.system).toContain('Call discover first.');
  expect(conversation.messages).toMatchObject([
    { kind: 'user', text: 'What is in the graph?' },
    { kind: 'assistant', text: 'The graph has notes.' },
  ]);
});

it('runs every tool call of a response and answers them in one user message, linked to activity request IDs', async () => {
  const tools = fakeTools((call) =>
    textResult({ status: 'succeeded', result: call.name }),
  );
  const { agent, model } = createTestAgent({
    tools,
    steps: [
      () =>
        reply([
          { type: 'text', text: 'Looking.' },
          toolUse('toolu_1', 'discover', {}),
          toolUse('toolu_2', 'execute', { code: 'return 1;' }),
        ]),
      () => reply([{ type: 'text', text: 'Done.' }]),
    ],
  });

  agent.send('alice', 'Look around');
  const conversation = await settled(agent, 'alice');
  const second = model.requests[1]!.messages;

  expect(second).toHaveLength(3);
  expect(second[1]).toMatchObject({
    role: 'assistant',
    content: [
      { type: 'text' },
      { type: 'tool_use', id: 'toolu_1' },
      { type: 'tool_use', id: 'toolu_2' },
    ],
  });
  expect(second[2]).toEqual({
    role: 'user',
    content: [
      {
        type: 'tool_result',
        tool_use_id: 'toolu_1',
        content: [
          {
            type: 'text',
            text: '{"status":"succeeded","result":"discover"}',
          },
        ],
      },
      {
        type: 'tool_result',
        tool_use_id: 'toolu_2',
        content: [
          { type: 'text', text: '{"status":"succeeded","result":"execute"}' },
        ],
      },
    ],
  });
  expect(tools.calls).toMatchObject([
    { principal: 'alice', name: 'discover', arguments: {} },
    { principal: 'alice', name: 'execute', arguments: { code: 'return 1;' } },
  ]);
  expect(toolMessages(conversation)).toMatchObject([
    {
      id: 'toolu_1',
      name: 'discover',
      status: 'succeeded',
      requestId: tools.calls[0]!.requestId,
    },
    {
      id: 'toolu_2',
      name: 'execute',
      input: 'return 1;',
      status: 'succeeded',
      requestId: tools.calls[1]!.requestId,
    },
  ]);
  expect(tools.calls[0]!.requestId).not.toBe(tools.calls[1]!.requestId);
});

it('keeps a separate history per principal', async () => {
  const { agent, model } = createTestAgent({
    steps: [
      () => reply([{ type: 'text', text: 'Hi alice.' }]),
      () => reply([{ type: 'text', text: 'Hi bob.' }]),
      () => reply([{ type: 'text', text: 'Again, alice.' }]),
    ],
  });

  agent.send('alice', 'I am alice');
  await settled(agent, 'alice');
  agent.send('bob', 'I am bob');
  await settled(agent, 'bob');
  agent.send('alice', 'Still alice');
  await settled(agent, 'alice');

  expect(model.requests[1]!.messages).toEqual([
    { role: 'user', content: 'I am bob' },
  ]);
  expect(model.requests[1]!.system).toContain('"bob"');
  expect(model.requests[2]!.messages).toMatchObject([
    { role: 'user', content: 'I am alice' },
    { role: 'assistant', content: [{ type: 'text', text: 'Hi alice.' }] },
    { role: 'user', content: 'Still alice' },
  ]);
  expect(
    conversationOf(agent, 'bob')!.messages.map((message) =>
      'text' in message ? message.text : message.kind,
    ),
  ).toEqual(['I am bob', 'Hi bob.']);
});

it('pins a running turn to its principal when the inspector switches to another', async () => {
  const release = deferred();
  const tools = fakeTools(async (call) => {
    if (call.principal === 'alice') await release.promise;

    return textResult({ status: 'succeeded', result: call.principal });
  });
  const { agent, model } = createTestAgent({
    tools,
    steps: [
      () => reply([toolUse('toolu_a', 'execute', { code: 'return 1;' })]),
      () => reply([{ type: 'text', text: 'Bob answered.' }]),
      () => reply([{ type: 'text', text: 'Alice answered.' }]),
    ],
  });

  const aliceTurn = agent.send('alice', 'Slow question');

  await waitUntil(() => tools.calls.length === 1, 'alice tool call');
  // The selector moves to bob: another conversation, another turn.
  agent.send('bob', 'Quick question');
  await settled(agent, 'bob');
  expect(conversationOf(agent, 'alice')!.turn).toEqual({
    turnId: aliceTurn.turnId,
    principal: 'alice',
    status: 'running',
  });
  release.resolve();
  const alice = await settled(agent, 'alice');

  expect(tools.connections).toEqual(['alice', 'bob']);
  expect(tools.calls.map((call) => call.principal)).toEqual(['alice']);
  expect(model.requests[2]!.system).toContain('"alice"');
  expect(model.requests[2]!.messages.at(-1)).toMatchObject({
    role: 'user',
    content: [{ type: 'tool_result', tool_use_id: 'toolu_a' }],
  });
  expect(alice.messages.at(-1)).toMatchObject({
    kind: 'assistant',
    text: 'Alice answered.',
  });
});

it('rejects a second turn for a principal while one is running', async () => {
  const release = deferred<Message>();
  const { agent } = createTestAgent({ steps: [() => release.promise] });

  agent.send('alice', 'First');

  expect(() => agent.send('alice', 'Second')).toThrow(
    expect.objectContaining({ status: 409 }),
  );
  release.resolve(reply([{ type: 'text', text: 'Done.' }]));
  await settled(agent, 'alice');
});

it('cancels a turn while the model is streaming and keeps the conversation usable', async () => {
  const { agent, model } = createTestAgent({
    steps: [
      () => new Promise<Message>(() => {}),
      () => reply([{ type: 'text', text: 'Fresh answer.' }]),
    ],
  });
  const { turnId } = agent.send('alice', 'Long question');

  await waitUntil(() => model.requests.length === 1, 'the first request');
  expect(agent.cancel(turnId)).toBe(true);
  const cancelled = await settled(agent, 'alice');

  expect(cancelled.messages.at(-1)).toMatchObject({
    kind: 'notice',
    level: 'info',
    text: 'Cancelled before the model finished.',
  });
  agent.send('alice', 'Another question');
  await settled(agent, 'alice');
  expect(model.requests[1]!.messages).toEqual([
    { role: 'user', content: 'Long question' },
    { role: 'user', content: 'Another question' },
  ]);
  expect(agent.cancel(turnId)).toBe(false);
});

it('cancels an in-flight tool call, reports it to the model as cancelled and never retries it', async () => {
  const tools = fakeTools(() => new Promise<CallToolResult>(() => {}));
  const { agent, model } = createTestAgent({
    tools,
    steps: [
      () =>
        reply([
          toolUse('toolu_1', 'execute', {
            code: "await graph.actions.addNote({ input: { body: 'x' } });",
          }),
        ]),
      () => reply([{ type: 'text', text: 'Should not be asked.' }]),
    ],
  });
  const { turnId } = agent.send('alice', 'Add a note');

  await waitUntil(() => tools.calls.length === 1, 'the tool call');
  agent.cancel(turnId);
  const conversation = await settled(agent, 'alice');

  // The next turn shows what the model is told about the cancelled call.
  agent.send('alice', 'What happened?');
  await settled(agent, 'alice');
  const history = model.requests[1]!.messages;

  expect(tools.calls).toHaveLength(1);
  expect(toolMessages(conversation)).toMatchObject([
    { id: 'toolu_1', status: 'cancelled' },
  ]);
  expect(conversation.messages.at(-1)).toMatchObject({
    kind: 'notice',
    text: 'Cancelled.',
  });
  expect(history.at(-2)).toEqual({
    role: 'user',
    content: [
      {
        type: 'tool_result',
        tool_use_id: 'toolu_1',
        is_error: true,
        content: [
          {
            type: 'text',
            text: expect.stringContaining('outcome is unknown'),
          },
        ],
      },
    ],
  });
  expect(history.at(-1)).toEqual({ role: 'user', content: 'What happened?' });
});

it.each([
  [
    'refusal',
    { stop_details: { type: 'refusal' as const, category: 'cyber' } },
    'The model declined to continue (cyber). Its unfinished tool call was not run.',
  ],
  [
    'max_tokens',
    {},
    'The response reached the 64,000-token output limit and was cut off. Its unfinished tool call was not run.',
  ],
])(
  'checks stop_reason %s before running tools',
  async (stopReason, extra, text) => {
    const tools = fakeTools();
    const { agent, model } = createTestAgent({
      tools,
      steps: [
        () =>
          reply([toolUse('toolu_1', 'execute', { code: 'return' })], {
            stop_reason: stopReason,
            ...extra,
          }),
        () => reply([{ type: 'text', text: 'Next.' }]),
      ],
    });

    agent.send('alice', 'Go');
    const conversation = await settled(agent, 'alice');

    agent.send('alice', 'Next');
    await settled(agent, 'alice');

    expect(tools.calls).toEqual([]);
    expect(conversation.messages.at(-1)).toMatchObject({
      kind: 'notice',
      level: 'warning',
      text,
    });
    expect(model.requests[1]!.messages.at(-2)).toMatchObject({
      role: 'user',
      content: [
        { type: 'tool_result', tool_use_id: 'toolu_1', is_error: true },
      ],
    });
  },
);

it('passes a retryable binding-unavailable result to the model and leaves the decision to it', async () => {
  const unavailable = {
    error: {
      code: 'binding-unavailable',
      message: 'The runtime is restarting; retry',
      retryable: true,
    },
  };
  const tools = fakeTools(() => textResult(unavailable, true));
  const { agent, model } = createTestAgent({
    tools,
    steps: [
      () => reply([toolUse('toolu_1', 'execute', { code: 'return 1;' })]),
      () => reply([{ type: 'text', text: 'The runtime is restarting.' }]),
    ],
  });

  agent.send('alice', 'Count notes');
  const conversation = await settled(agent, 'alice');

  expect(tools.calls).toHaveLength(1);
  expect(model.requests[1]!.messages.at(-1)).toEqual({
    role: 'user',
    content: [
      {
        type: 'tool_result',
        tool_use_id: 'toolu_1',
        is_error: true,
        content: [{ type: 'text', text: JSON.stringify(unavailable) }],
      },
    ],
  });
  expect(toolMessages(conversation)).toMatchObject([{ status: 'failed' }]);
});

it('without ANTHROPIC_API_KEY reports missing-key and refuses turns with the setup', async () => {
  const tools = fakeTools();
  const createClient = vi.fn();
  const agent = createAgent({
    env: { PATH: '/usr/bin' },
    principals: () => ({ names: ['alice'] }),
    connect: tools.connect,
    createClient,
  });

  expect(agent.availability).toEqual({
    available: false,
    reason: 'missing-key',
  });
  expect(() => agent.send('alice', 'Hello')).toThrow(
    new AgentRequestError(503, agentSetup),
  );
  expect(agentSnapshotSchema.parse(agent.snapshot())).toEqual({
    type: 'snapshot',
    availability: { available: false, reason: 'missing-key' },
    conversations: [],
  });
  expect(createClient).not.toHaveBeenCalled();
  expect(tools.connections).toEqual([]);
});

it('rejects a turn for a principal the model does not declare', () => {
  const { agent } = createTestAgent({ steps: [], principals: ['alice'] });

  expect(() => agent.send('mallory', 'Hello')).toThrow(
    expect.objectContaining({ status: 404 }),
  );
});

/** The dev server's routes with an agent, driven through `app.fetch`. */
async function createRouteHarness(agent: Agent) {
  const origin = 'http://127.0.0.1:4318';
  const sessions = createSessions({
    instanceId: 'agent-test',
    allowedOrigins: [origin],
  });
  const dev = createDevServer({
    supervisor: new Supervisor('agent-test'),
    sessions,
    ownerId: 'owner',
    activity: createActivityLog(),
    agent,
    heartbeatMs: 60_000,
  });

  cleanups.push(async () => dev.closeStreams());

  const exchange = await dev.app.fetch(
    new Request(`${origin}/dev/session`, {
      method: 'POST',
      headers: {
        host: '127.0.0.1:4318',
        origin,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ token: sessions.token }),
    }),
  );
  const cookie = (exchange.headers.get('set-cookie') ?? '').split(';')[0]!;
  const request = (
    path: string,
    init: {
      method?: string;
      body?: unknown;
      headers?: Record<string, string>;
    } = {},
  ) =>
    dev.app.fetch(
      new Request(`${origin}${path}`, {
        method: init.method ?? 'GET',
        headers: {
          host: '127.0.0.1:4318',
          cookie,
          ...(init.body !== undefined
            ? { origin, 'content-type': 'application/json' }
            : {}),
          ...init.headers,
        },
        ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
      }),
    );

  return { request, origin };
}

/** Read an SSE response until `done` holds for the payloads so far. */
async function readEvents(
  response: Response,
  done: (events: AgentEvent[]) => boolean,
): Promise<{ events: AgentEvent[]; raw: string }> {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let raw = '';
  const events: AgentEvent[] = [];

  while (!done(events)) {
    const { value, done: ended } = await reader.read();

    if (ended) break;

    raw += decoder.decode(value, { stream: true });
    events.splice(
      0,
      events.length,
      ...raw
        .split('\n')
        .filter((line) => line.startsWith('data: ') && line.length > 6)
        .map((line) => agentEventSchema.parse(JSON.parse(line.slice(6)))),
    );
  }

  await reader.cancel();

  return { events, raw };
}

it('serves turns, cancellation, conversations and events under /dev/agent with a session', async () => {
  const hold = deferred<Message>();
  const { agent } = createTestAgent({
    steps: [() => hold.promise, () => reply([{ type: 'text', text: 'Hi.' }])],
  });
  const { request } = await createRouteHarness(agent);
  const stream = await request('/dev/agent/events', {
    headers: { accept: 'text/event-stream' },
  });

  expect(
    (await request('/dev/agent/conversations', { headers: { cookie: '' } }))
      .status,
  ).toBe(401);

  const accepted = await request('/dev/agent/turns', {
    method: 'POST',
    body: { principal: 'alice', text: 'Hello' },
  });
  const turn = agentTurnAcceptedSchema.parse(await accepted.json());

  expect(accepted.status).toBe(202);
  expect(
    (
      await request(`/dev/agent/turns/${turn.turnId}/cancel`, {
        method: 'POST',
        body: {},
      })
    ).status,
  ).toBe(202);
  await settled(agent, 'alice');
  expect(
    (
      await request(`/dev/agent/turns/${turn.turnId}/cancel`, {
        method: 'POST',
        body: {},
      })
    ).status,
  ).toBe(404);

  const { events } = await readEvents(stream, (seen) =>
    seen.some((event) => event.type === 'turn' && event.turn === null),
  );

  expect(events.map((event) => event.type)).toEqual([
    'snapshot',
    'turn',
    'message',
    'turn',
    'message',
    'turn',
  ]);
  expect(events[3]).toMatchObject({ turn: { status: 'cancelling' } });

  const conversations = agentSnapshotSchema.parse(
    await (await request('/dev/agent/conversations')).json(),
  );

  expect(conversations.conversations).toMatchObject([
    {
      principal: 'alice',
      turn: null,
      messages: [{ kind: 'user', text: 'Hello' }, { kind: 'notice' }],
    },
  ]);
});

it('refuses turns that do not come from the inspector page', async () => {
  const { agent } = createTestAgent({ steps: [] });
  const { request } = await createRouteHarness(agent);
  const withoutOrigin = await request('/dev/agent/turns', {
    method: 'POST',
    headers: { origin: '' },
    body: { principal: 'alice', text: 'Hi' },
  });
  const crossSite = await request('/dev/agent/turns', {
    method: 'POST',
    headers: { origin: 'https://evil.example' },
    body: { principal: 'alice', text: 'Hi' },
  });
  const empty = await request('/dev/agent/turns', {
    method: 'POST',
    body: { principal: 'alice', text: '   ' },
  });

  expect(withoutOrigin.status).toBe(403);
  expect(crossSite.status).toBe(403);
  expect(empty.status).toBe(400);
  expect(conversationOf(agent, 'alice')).toBeUndefined();
});

it('answers 503 with the setup when no key is configured', async () => {
  const agent = createAgent({
    env: {},
    principals: () => ({ names: ['alice'] }),
    connect: fakeTools().connect,
  });
  const { request } = await createRouteHarness(agent);
  const response = await request('/dev/agent/turns', {
    method: 'POST',
    body: { principal: 'alice', text: 'Hi' },
  });

  expect(response.status).toBe(503);
  expect(await response.json()).toEqual({ error: agentSetup });
});

it('never sends the API key to the browser, even inside an error', async () => {
  const key = 'sk-ant-api03-secret-key-for-tests';
  const { agent } = createTestAgent({
    env: { ANTHROPIC_API_KEY: key },
    steps: [
      () => {
        throw new Error(`upstream echoed ${key}`);
      },
    ],
  });
  const { request } = await createRouteHarness(agent);
  const stream = await request('/dev/agent/events', {
    headers: { accept: 'text/event-stream' },
  });
  const accepted = await request('/dev/agent/turns', {
    method: 'POST',
    body: { principal: 'alice', text: 'Hello' },
  });
  const conversation = await settled(agent, 'alice');
  const { raw } = await readEvents(stream, (seen) =>
    seen.some((event) => event.type === 'turn' && event.turn === null),
  );
  const payloads = [
    raw,
    await accepted.text(),
    await (await request('/dev/agent/conversations')).text(),
    await (await request('/dev/snapshot')).text(),
    await (await request('/dev/activity')).text(),
  ];

  expect(conversation.messages.at(-1)).toMatchObject({
    kind: 'notice',
    level: 'error',
    text: 'upstream echoed [redacted]',
  });

  for (const payload of payloads) expect(payload).not.toContain(key);
});

/** A native Note object, an action that creates one and two principals. */
const noteApp = `import { z } from 'zod';
import {
  defineAccess, defineAction, defineApp, defineGraph, defineObject,
  implementAction, native, nativeMembership, objectId,
} from 'relate';

const access = defineAccess({ roles: ['writer'], fieldGroups: ['ordinary'], claims: {} });
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
  policies: { Note: { read: { gate: access.role('writer') }, create: { gate: access.role('writer') } } },
  principals: { alice: { roles: ['writer'] }, bob: { roles: [] } },
});
const addNote = implementAction(graph, AddNote, async ({ input, objects }) => {
  await objects.Note.create({ body: input.body });

  return { ok: true };
});

export default defineApp({
  graph,
  setup: () => ({ connections: [], actionImplementations: [addNote] }),
});
`;

/**
 * The real path: a loopback listener serving the dev server and `/mcp`, and
 * the agent connected to it with the in-process agent token.
 */
async function createLoopback(options: {
  steps: Step[];
  /** Replace the runtime; default: a real runtime host running `noteApp`. */
  runtime?: 'note-app' | { binding(principal: string): Promise<never> };
}) {
  const activity = createActivityLog();
  let runtime;
  let running: RuntimeStatus | null = null;

  if (options.runtime && options.runtime !== 'note-app')
    runtime = options.runtime;
  else {
    const root = await mkdtemp(join(tmpdir(), 'relate-agent-test-'));

    cleanups.push(() => rm(root, { recursive: true, force: true }));
    await symlink(join(repoRoot, 'node_modules'), join(root, 'node_modules'));

    const statuses: RuntimeStatus[] = [];
    const controller = createRuntimeController({
      projectRoot: root,
      configPath: join(root, 'relate.config.ts'),
      env: process.env,
      onStatus: (status) => statuses.push(status),
      writeStdout: () => {},
      writeStderr: () => {},
    });

    cleanups.push(() => controller.stop());

    const path = join(root, 'build-1.mjs');

    await writeFile(path, noteApp);
    await controller.restart({
      generation: 1,
      bundle: { path, release: async () => {} },
    });
    running = await waitUntil(
      () => statuses.find((status) => status.state === 'running'),
      'the runtime host',
      15_000,
    );
    runtime = controller;
  }

  const mcp = createMcpEndpoint({
    token: createMcpToken(),
    runtime,
    principals: () => ({ names: ['alice', 'bob'], defaultPrincipal: 'alice' }),
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
  const model = fakeModel(options.steps);
  const agent = createAgent({
    env: { ANTHROPIC_API_KEY: 'sk-ant-test-key' },
    principals: () => ({ names: ['alice', 'bob'] }),
    connect: connectLoopbackMcp({ url: `${url}/mcp`, token: mcp.agentToken }),
    createClient: () => model.client,
  });

  cleanups.push(() => agent.stop());

  const dev = createDevServer({
    supervisor: new Supervisor('agent-e2e'),
    sessions: createSessions({
      instanceId: 'agent-e2e',
      allowedOrigins: [url],
    }),
    ownerId: 'owner',
    activity,
    agent,
    mcp: mcp.handle,
  });

  app = dev.app;
  cleanups.push(async () => dev.closeStreams());

  return { agent, model, activity, running, mcp };
}

it('runs a turn end to end through the real /mcp as the agent, recorded as inspector-agent activity', async () => {
  const key = 'sk-ant-api03-never-in-children';

  vi.stubEnv('ANTHROPIC_API_KEY', key);

  const { agent, model, activity, running, mcp } = await createLoopback({
    steps: [
      () =>
        reply([
          toolUse('toolu_1', 'execute', {
            code: `const receipt = await graph.actions.addNote({ input: { body: 'From the agent' }, idempotencyKey: 'agent-1' });
const page = await graph.objects.Note.query({ limit: 10 });
return { state: receipt.state, notes: page.data.length, key: process.env.ANTHROPIC_API_KEY ?? 'absent' };`,
          }),
        ]),
      () => reply([{ type: 'text', text: 'Added one note.' }]),
    ],
  });

  expect(mcp.agentToken).not.toBe(mcp.token);
  agent.send('alice', 'Add a note');
  const conversation = await settled(agent, 'alice');
  const [tool] = toolMessages(conversation);
  const events = activity.snapshot();
  const call = events.find(
    (event): event is CallEvent => event.kind === 'call',
  );
  const execution = events.find(
    (event): event is ExecutionEvent => event.kind === 'execution',
  );
  const result = model.requests[1]!.messages.at(-1)!;

  expect(tool).toMatchObject({ id: 'toolu_1', status: 'succeeded' });
  expect(call).toMatchObject({
    requestId: tool!.requestId,
    source: 'inspector-agent',
    principal: 'alice',
    tool: 'execute',
    status: 'succeeded',
    runtimeId: running!.runtimeId,
  });
  expect(execution).toMatchObject({
    requestId: tool!.requestId,
    status: 'succeeded',
    resultPreview: '{"state":"succeeded","notes":1,"key":"absent"}',
  });
  expect(events.filter((event) => event.kind === 'operation')).toMatchObject([
    {
      op: 'invoke',
      definitionId: 'notes.add',
      context: { requestId: tool!.requestId },
    },
    {
      op: 'query',
      definitionId: 'notes.note',
      context: { requestId: tool!.requestId },
    },
  ]);
  expect(result).toMatchObject({
    role: 'user',
    content: [
      {
        type: 'tool_result',
        tool_use_id: 'toolu_1',
        content: [
          { type: 'text', text: expect.stringContaining('"key":"absent"') },
        ],
      },
    ],
  });
  expect(JSON.stringify(events)).not.toContain(key);
});

it('delivers a retryable BindingUnavailableError from the real /mcp to the model once', async () => {
  const { agent, model, activity } = await createLoopback({
    runtime: {
      binding: async () => {
        throw new RuntimeUnavailableError(
          'The runtime is restarting for generation 2',
          'not-running',
          true,
        );
      },
    },
    steps: [
      () => reply([toolUse('toolu_1', 'discover', {})]),
      () => reply([{ type: 'text', text: 'It is restarting; ask me again.' }]),
    ],
  });

  agent.send('bob', 'What can I see?');
  const conversation = await settled(agent, 'bob');
  const result = model.requests[1]!.messages.at(-1)!;

  expect(result).toMatchObject({
    role: 'user',
    content: [{ type: 'tool_result', tool_use_id: 'toolu_1', is_error: true }],
  });
  expect(
    JSON.parse(
      (result.content as { content: { text: string }[] }[])[0]!.content[0]!
        .text,
    ),
  ).toEqual({
    error: {
      code: 'binding-unavailable',
      message: 'The runtime is restarting for generation 2',
      retryable: true,
    },
  });
  expect(model.requests).toHaveLength(2);
  expect(toolMessages(conversation)).toMatchObject([{ status: 'failed' }]);
  expect(
    activity.snapshot().filter((event) => event.kind === 'call'),
  ).toMatchObject([
    {
      source: 'inspector-agent',
      principal: 'bob',
      status: 'failed',
      requestId: toolMessages(conversation)[0]!.requestId,
    },
  ]);
});
