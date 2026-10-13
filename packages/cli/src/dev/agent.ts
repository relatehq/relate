/**
 * The inspector's built-in agent and its `/dev/agent/*` routes.
 *
 * The loop runs here, in the dev server, because the API key must stay
 * server-side: `ANTHROPIC_API_KEY` is read from the dev server's environment
 * only, and the compile worker, runtime host, execute children and browser
 * never see it. Without a key the agent reports `missing-key` and nothing
 * else in `relate dev` changes.
 *
 * The model reaches the graph exactly as an external client does: an MCP
 * client connects to this server's own `/mcp?as=<principal>` over loopback
 * with the in-process agent token, lists its tools, and forwards each
 * `tool_use` as a `tools/call`. Each call names its activity request ID in
 * `_meta`, so a chat tool call links to its Activity entry while it runs.
 *
 * One conversation per development principal. A turn is pinned to the
 * principal it started with; selecting another principal in the inspector
 * shows another conversation and never touches a running turn. Cancelling a
 * turn aborts MCP setup, the model stream and any in-flight tool call. History
 * records the cancellation so the request is not resumed. A cancelled call
 * is reported to the model as cancelled with an unknown outcome, never
 * retried. A retryable `binding-unavailable` result (the runtime restarting)
 * reaches the model as the tool result; the model decides what to do.
 *
 * A conversation can be reset to start afresh, for example once it no longer
 * fits the model's context window. When the runtime restarted since the
 * previous turn, the next user message tells the model that earlier reads may
 * describe data that no longer exists.
 */
import { randomUUID } from 'node:crypto';
import Anthropic from '@anthropic-ai/sdk';
import {
  Client,
  StreamableHTTPClientTransport,
} from '@modelcontextprotocol/client';
import type { CallToolResult, Tool } from '@modelcontextprotocol/client';
import type { Context, Hono } from 'hono';
import {
  agentTurnRequestSchema,
  type AgentAvailability,
  type AgentConversation,
  type AgentEvent,
  type AgentMessage,
  type AgentResetAccepted,
  type AgentSnapshot,
  type AgentToolMessage,
  type AgentTurn,
  type AgentTurnAccepted,
} from '@relate/inspector/protocol';
import { preview, requestIdMeta, truncate } from './activity/index.js';
import type { Sessions } from './session.js';
import { streamJson, type SseStreams } from './sse.js';

type BetaMessage = Anthropic.Beta.Messages.BetaMessage;

type BetaMessageParam = Anthropic.Beta.Messages.BetaMessageParam;

type BetaTool = Anthropic.Beta.Messages.BetaTool;

type BetaToolUseBlock = Anthropic.Beta.Messages.BetaToolUseBlock;

type BetaToolResultBlockParam =
  Anthropic.Beta.Messages.BetaToolResultBlockParam;

type BetaStreamEvent = Anthropic.Beta.Messages.BetaRawMessageStreamEvent;

export type AgentStreamParams = Parameters<
  Anthropic['beta']['messages']['stream']
>[0];

export const agentModel = 'claude-opus-5-5';
/** Set explicitly: Claude Opus 5.5 defaults to `medium`; agentic tool use wants more. */
export const agentEffort = 'high';
export const agentMaxTokens = 64_000;
/** Model responses per turn before the loop stops and asks for a new message. */
export const agentMaxModelCalls = 40;

/** Display messages kept per conversation; the model's history is not trimmed. */
const displayLimit = 500;

/** The part of `@anthropic-ai/sdk` the loop uses; tests inject a fake. */
export interface AgentModelClient {
  readonly beta: {
    readonly messages: {
      stream(
        params: AgentStreamParams,
        options: { readonly signal: AbortSignal },
      ): AgentModelStream;
    };
  };
}

export interface AgentModelStream {
  on(event: 'streamEvent', listener: (event: BetaStreamEvent) => void): unknown;
  finalMessage(): Promise<BetaMessage>;
}

/** One principal's MCP connection for the length of a turn. */
export interface AgentToolSession {
  /** The server's usage instructions, added to the system prompt. */
  readonly instructions: string | undefined;
  readonly tools: readonly Tool[];
  callTool(
    call: {
      readonly name: string;
      readonly arguments: Record<string, unknown>;
      /** The activity request ID the dev server records this call under. */
      readonly requestId: string;
    },
    signal: AbortSignal,
  ): Promise<CallToolResult>;
  close(): Promise<void>;
}

export type ConnectAgentTools = (
  principal: string,
  signal: AbortSignal,
) => Promise<AgentToolSession>;

export interface AgentOptions {
  /** The dev server's environment; only `ANTHROPIC_API_KEY` is read. */
  readonly env: NodeJS.ProcessEnv;
  /** The accepted model's principals, or null before the first model. */
  readonly principals: () => { readonly names: readonly string[] } | null;
  readonly connect: ConnectAgentTools;
  /** Default: the Anthropic SDK with the key from `env`. */
  readonly createClient?: (apiKey: string) => AgentModelClient;
  /** The running runtime host's ID, or null; used to notice restarts between turns. */
  readonly runtimeId?: () => string | null;
}

export type AgentListener = (event: AgentEvent) => void;

export interface Agent {
  readonly availability: AgentAvailability;
  snapshot(): AgentSnapshot;
  /** Snapshot and registration are atomic: no event falls between them. */
  subscribe(listener: AgentListener): {
    readonly snapshot: AgentSnapshot;
    unsubscribe(): void;
  };
  /** Start a turn as `principal`; throws `AgentRequestError` when it cannot. */
  send(principal: string, text: string): AgentTurnAccepted;
  /** Cancel a running turn; false when no such turn is running. */
  cancel(turnId: string): boolean;
  /** Clear a principal's conversation; throws `AgentRequestError` while a turn runs. */
  reset(principal: string): AgentResetAccepted;
  /** Cancel every turn and wait for them to end, for shutdown. */
  stop(): Promise<void>;
}

export class AgentRequestError extends Error {
  readonly status: 400 | 404 | 409 | 503;

  constructor(status: AgentRequestError['status'], message: string) {
    super(message);
    this.name = 'AgentRequestError';
    this.status = status;
  }
}

/** The setup explanation the panel shows, and the 503 a turn gets, without a key. */
export const agentSetup =
  'Set ANTHROPIC_API_KEY in the project .env and start relate dev with: pnpm exec dotenvx run -f .env -- pnpm relate dev';

/** MCP tools as Anthropic tools: the two shapes differ, so map them field by field. */
export function toAnthropicTools(tools: readonly Tool[]): BetaTool[] {
  return tools.map((tool) => {
    // `$schema` names the draft for MCP validators; the API does not need it.
    const { $schema: _draft, ...schema } = tool.inputSchema as Record<
      string,
      unknown
    >;

    return {
      name: tool.name,
      description: tool.description ?? '',
      input_schema: schema as BetaTool['input_schema'],
    };
  });
}

/** An MCP tool result as the `tool_result` block that answers `toolUseId`. */
export function toToolResult(
  toolUseId: string,
  result: CallToolResult,
): BetaToolResultBlockParam {
  const content = (result.content ?? []).map((block) =>
    block.type === 'text'
      ? { type: 'text' as const, text: block.text }
      : { type: 'text' as const, text: JSON.stringify(block) },
  );

  if (content.length === 0 && result.structuredContent !== undefined)
    content.push({
      type: 'text',
      text: JSON.stringify(result.structuredContent),
    });

  return {
    type: 'tool_result',
    tool_use_id: toolUseId,
    content,
    ...(result.isError ? { is_error: true } : {}),
  };
}

function errorResult(
  toolUseId: string,
  text: string,
): BetaToolResultBlockParam {
  return {
    type: 'tool_result',
    tool_use_id: toolUseId,
    content: [{ type: 'text', text }],
    is_error: true,
  };
}

/** Prepended to the first user message after the runtime restarted. */
export const runtimeRestartedNote =
  'Note from relate dev: the runtime restarted since your previous turn (the developer changed code). Data in the in-memory store was reset, so records and receipts from earlier tool results may no longer exist. Re-read before relying on them.';

const cancelledResult =
  'Cancelled by the developer before this call finished. Its outcome is unknown: an action may or may not have run. It was not retried; check the data before acting again.';

export function systemPrompt(
  principal: string,
  instructions: string | undefined,
): string {
  return [
    `You are the built-in agent of the Relate inspector, running inside \`relate dev\` on a developer's machine. The person asking is the selected development principal "${principal}". You are their assistant: every read and action through the tools uses their permissions. Address them directly as "you" and describe what you can see or do for them. Do not speak as them (for example, "As ${principal}, I...") or refer to them in the third person. For example, say "I couldn't find any invoices you can access." When something is missing or denied, say so plainly; that is often what the developer is testing.`,
    'Use `discover` to learn the graph, then `execute` to run JavaScript against it. Actions change data in the running application; take one only when the developer asks for it.',
    'A tool result with error code `binding-unavailable` means the runtime cannot serve calls right now. When `retryable` is true it is restarting after a code change and a read may be retried; never repeat an action whose outcome you do not know without asking the developer.',
    'Keep answers short and concrete.',
    ...(instructions ? [instructions] : []),
  ].join('\n\n');
}

/** The real tool session: this dev server's own `/mcp` over loopback. */
export function connectLoopbackMcp(options: {
  /** `<origin>/mcp` of this dev server. */
  readonly url: string;
  /** The in-process agent token (`McpEndpoint.agentToken`). */
  readonly token: string;
}): ConnectAgentTools {
  return async (principal, signal) => {
    signal.throwIfAborted();

    const client = new Client({
      name: 'relate-inspector-agent',
      version: '0.0.0-dev.0',
    });
    const url = new URL(options.url);

    url.searchParams.set('as', principal);
    const transport = new StreamableHTTPClientTransport(url, {
      requestInit: {
        headers: { authorization: `Bearer ${options.token}` },
      },
    });
    // Also interrupt handshake notifications, which have no request signal.
    const abort = () => {
      void transport.close().catch(() => {});
    };

    signal.addEventListener('abort', abort, { once: true });

    try {
      await client.connect(transport, { signal });
      signal.throwIfAborted();
      const { tools } = await client.listTools(undefined, { signal });

      signal.throwIfAborted();

      return {
        instructions: client.getInstructions(),
        tools,
        callTool: ({ name, arguments: input, requestId }, signal) =>
          client.callTool(
            { name, arguments: input, _meta: { [requestIdMeta]: requestId } },
            { signal },
          ) as Promise<CallToolResult>,
        close: () => client.close(),
      };
    } catch (error) {
      await client.close().catch(() => {});

      throw error;
    } finally {
      signal.removeEventListener('abort', abort);
    }
  };
}

interface RunningTurn {
  readonly turnId: string;
  readonly principal: string;
  status: AgentTurn['status'];
  readonly controller: AbortController;
  done: Promise<void>;
}

interface Conversation {
  readonly principal: string;
  /** The runtime the previous turn started on, to notice a restart. */
  runtimeId: string | null;
  /** What the model sees: appended to, never edited (thinking stays valid). */
  readonly history: BetaMessageParam[];
  /** What the inspector shows, by ID in first-seen order. */
  readonly messages: Map<string, AgentMessage>;
  turn: RunningTurn | null;
}

const publicTurn = (turn: RunningTurn): AgentTurn => ({
  turnId: turn.turnId,
  principal: turn.principal,
  status: turn.status,
});

/** The input shown for a tool call: `execute` code as written, anything else as JSON. */
function toolInput(use: BetaToolUseBlock): string {
  const input = use.input as { code?: unknown } | null;

  if (use.name === 'execute' && typeof input?.code === 'string')
    return truncate(input.code, 16 * 1024).text;

  return preview(use.input);
}

function resultPreview(block: BetaToolResultBlockParam): string {
  const content = Array.isArray(block.content) ? block.content : [];

  return truncate(
    content
      .map((part) => (part.type === 'text' ? part.text : `[${part.type}]`))
      .join('\n'),
    1024,
  ).text;
}

export function createAgent(options: AgentOptions): Agent {
  const apiKey = options.env.ANTHROPIC_API_KEY?.trim() || null;
  const availability: AgentAvailability = apiKey
    ? { available: true, model: agentModel }
    : { available: false, reason: 'missing-key' };
  const client: AgentModelClient | null = apiKey
    ? (options.createClient ?? ((key) => new Anthropic({ apiKey: key })))(
        apiKey,
      )
    : null;
  const conversations = new Map<string, Conversation>();
  const listeners = new Set<AgentListener>();
  /** The key never leaves this process, not even inside an error message. */
  const redact = (text: string) =>
    apiKey ? text.replaceAll(apiKey, '[redacted]') : text;
  const emit = (event: AgentEvent) => {
    for (const listener of [...listeners]) listener(event);
  };
  const conversation = (principal: string): Conversation => {
    let found = conversations.get(principal);

    if (!found) {
      found = {
        principal,
        runtimeId: null,
        history: [],
        messages: new Map(),
        turn: null,
      };
      conversations.set(principal, found);
    }

    return found;
  };
  const upsert = (target: Conversation, message: AgentMessage) => {
    const clean = { ...message } as AgentMessage;

    if (
      clean.kind === 'notice' ||
      clean.kind === 'assistant' ||
      clean.kind === 'thinking'
    )
      clean.text = redact(clean.text);

    if (clean.kind === 'tool' && clean.result !== undefined)
      clean.result = redact(clean.result);

    target.messages.set(clean.id, clean);

    while (target.messages.size > displayLimit)
      target.messages.delete(target.messages.keys().next().value!);

    emit({ type: 'message', principal: target.principal, message: clean });
  };
  const appendText = (target: Conversation, id: string, delta: string) => {
    const message = target.messages.get(id);

    if (message?.kind !== 'assistant' && message?.kind !== 'thinking') return;

    const clean = redact(delta);

    target.messages.set(id, { ...message, text: message.text + clean });
    emit({
      type: 'text',
      principal: target.principal,
      messageId: id,
      delta: clean,
    });
  };
  const notice = (
    target: Conversation,
    level: 'info' | 'warning' | 'error',
    text: string,
  ) => upsert(target, { kind: 'notice', id: randomUUID(), level, text });
  const snapshot = (): AgentSnapshot => ({
    type: 'snapshot',
    availability,
    conversations: [...conversations.values()].map(
      (entry): AgentConversation => ({
        principal: entry.principal,
        turn: entry.turn ? publicTurn(entry.turn) : null,
        messages: [...entry.messages.values()],
      }),
    ),
  });

  /** Stream one model response, showing its text and thinking summaries as they arrive. */
  const respond = async (
    target: Conversation,
    request: { readonly system: string; readonly tools: BetaTool[] },
    signal: AbortSignal,
  ): Promise<BetaMessage> => {
    const stream = client!.beta.messages.stream(
      {
        model: agentModel,
        max_tokens: agentMaxTokens,
        // Summarized so the panel shows progress instead of a silent wait.
        thinking: { type: 'adaptive', display: 'summarized' },
        output_config: { effort: agentEffort },
        cache_control: { type: 'ephemeral' },
        system: request.system,
        tools: request.tools,
        messages: [...target.history],
      },
      { signal },
    );
    let block: string | null = null;

    stream.on('streamEvent', (event) => {
      if (event.type === 'content_block_start') {
        block = null;

        if (event.content_block.type === 'text') {
          block = randomUUID();
          upsert(target, {
            kind: 'assistant',
            id: block,
            text: event.content_block.text,
          });
        } else if (event.content_block.type === 'thinking') {
          block = randomUUID();
          upsert(target, {
            kind: 'thinking',
            id: block,
            text: event.content_block.thinking,
          });
        }
      } else if (event.type === 'content_block_delta' && block !== null) {
        if (event.delta.type === 'text_delta')
          appendText(target, block, event.delta.text);
        else if (event.delta.type === 'thinking_delta')
          appendText(target, block, event.delta.thinking);
      }
    });

    return stream.finalMessage();
  };

  /** Run every `tool_use` of one response; the results answer them in order. */
  const runTools = (
    target: Conversation,
    session: AgentToolSession,
    uses: readonly BetaToolUseBlock[],
    signal: AbortSignal,
  ): Promise<BetaToolResultBlockParam[]> =>
    Promise.all(
      uses.map(async (use) => {
        const shown: AgentToolMessage = {
          kind: 'tool',
          id: use.id,
          name: use.name,
          input: toolInput(use),
          requestId: randomUUID(),
          status: 'running',
        };
        const finish = (
          status: AgentToolMessage['status'],
          block: BetaToolResultBlockParam,
        ) => {
          upsert(target, { ...shown, status, result: resultPreview(block) });

          return block;
        };

        upsert(target, shown);

        if (signal.aborted)
          return finish('cancelled', errorResult(use.id, cancelledResult));

        const input =
          use.input !== null &&
          typeof use.input === 'object' &&
          !Array.isArray(use.input)
            ? (use.input as Record<string, unknown>)
            : {};

        try {
          const result = await session.callTool(
            { name: use.name, arguments: input, requestId: shown.requestId },
            signal,
          );
          const block = toToolResult(use.id, result);

          return finish(result.isError ? 'failed' : 'succeeded', block);
        } catch (error) {
          if (signal.aborted)
            return finish('cancelled', errorResult(use.id, cancelledResult));

          return finish(
            'failed',
            errorResult(
              use.id,
              `The tool call failed: ${redact(
                error instanceof Error ? error.message : String(error),
              )}`,
            ),
          );
        }
      }),
    );

  /** Why the turn ended, when the developer should know. */
  const stopNotice = (
    target: Conversation,
    message: BetaMessage,
    unanswered: number,
  ) => {
    const notRun = unanswered
      ? ` Its unfinished tool call${unanswered === 1 ? ' was' : 's were'} not run.`
      : '';

    switch (message.stop_reason) {
      case 'end_turn':
      case 'stop_sequence':
      case null:
        return;
      case 'max_tokens':
        notice(
          target,
          'warning',
          `The response reached the ${agentMaxTokens.toLocaleString('en')}-token output limit and was cut off.${notRun}`,
        );

        return;
      case 'refusal': {
        const category = message.stop_details?.category;

        notice(
          target,
          'warning',
          `The model declined to continue${category ? ` (${category})` : ''}.${notRun}`,
        );

        return;
      }
      case 'model_context_window_exceeded':
        notice(
          target,
          'warning',
          `This conversation no longer fits the model's context window.${notRun}`,
        );

        return;
      default:
        notice(target, 'info', `The model stopped: ${message.stop_reason}.`);
    }
  };

  const describe = (error: unknown): string => {
    if (error instanceof Anthropic.AuthenticationError)
      return 'The Anthropic API rejected ANTHROPIC_API_KEY. Check the key in the project .env and restart relate dev.';

    if (error instanceof Anthropic.RateLimitError)
      return 'The Anthropic API is rate limiting this key; try again shortly.';

    if (error instanceof Anthropic.APIConnectionError)
      return `Could not reach the Anthropic API: ${error.message}`;

    if (error instanceof Anthropic.APIError)
      return `The Anthropic API returned an error${
        error.status ? ` (${error.status})` : ''
      }: ${error.message}`;

    return error instanceof Error ? error.message : String(error);
  };

  const run = async (target: Conversation, turn: RunningTurn) => {
    const { signal } = turn.controller;
    let session: AgentToolSession | null = null;

    try {
      session = await options.connect(turn.principal, signal);

      const request = {
        system: systemPrompt(turn.principal, session.instructions),
        tools: toAnthropicTools(session.tools),
      };

      for (let call = 0; call < agentMaxModelCalls; call += 1) {
        if (signal.aborted) throw signal.reason;

        const message = await respond(target, request, signal);
        const uses = message.content.filter(
          (block): block is BetaToolUseBlock => block.type === 'tool_use',
        );

        target.history.push({ role: 'assistant', content: message.content });

        if (message.stop_reason === 'tool_use' && uses.length > 0) {
          const results = await runTools(target, session, uses, signal);

          target.history.push({ role: 'user', content: results });

          if (signal.aborted) {
            notice(target, 'info', 'Cancelled.');

            return;
          }

          continue;
        }

        // A server-side pause: send the response back so the model resumes.
        if (message.stop_reason === 'pause_turn' && uses.length === 0) continue;

        // Any other stop leaves its tool calls unrun; answer them so the
        // history stays valid for the next turn.
        if (uses.length > 0)
          target.history.push({
            role: 'user',
            content: uses.map((use) =>
              errorResult(
                use.id,
                `Not run: the response stopped (${message.stop_reason}) before this call was complete.`,
              ),
            ),
          });

        stopNotice(target, message, uses.length);

        return;
      }

      notice(
        target,
        'warning',
        `Stopped after ${agentMaxModelCalls} model responses in one turn. Send a message to continue.`,
      );
    } catch (error) {
      if (signal.aborted)
        notice(target, 'info', 'Cancelled before the model finished.');
      else notice(target, 'error', redact(describe(error)));
    } finally {
      if (signal.aborted)
        target.history.push({
          role: 'user',
          content:
            'The developer cancelled this turn. Do not resume the cancelled request unless they explicitly ask you to. Cancellation does not undo completed actions; any tool outcome reported as unknown must be checked before acting again.',
        });

      await session?.close().catch(() => {});
      target.turn = null;
      emit({ type: 'turn', principal: target.principal, turn: null });
    }
  };

  return {
    availability,
    snapshot,
    subscribe(listener) {
      listeners.add(listener);

      return {
        snapshot: snapshot(),
        unsubscribe: () => {
          listeners.delete(listener);
        },
      };
    },
    send(principal, text) {
      if (!client) throw new AgentRequestError(503, agentSetup);

      const declared = options.principals();

      if (!declared)
        throw new AgentRequestError(
          409,
          'No model has compiled yet; fix the errors shown by relate dev',
        );

      if (!declared.names.includes(principal))
        throw new AgentRequestError(
          404,
          `Unknown development principal '${principal}'. Declared: ${
            declared.names.join(', ') || 'none'
          }`,
        );

      const target = conversation(principal);

      if (target.turn)
        throw new AgentRequestError(
          409,
          `A turn is already running as '${principal}'; cancel it or wait for it to finish`,
        );

      const turn: RunningTurn = {
        turnId: randomUUID(),
        principal,
        status: 'running',
        controller: new AbortController(),
        done: Promise.resolve(),
      };

      // A restart between turns reset in-memory data; say so once.
      const runtimeId = options.runtimeId?.() ?? null;
      const restarted =
        target.history.length > 0 &&
        target.runtimeId !== null &&
        runtimeId !== null &&
        runtimeId !== target.runtimeId;

      if (runtimeId !== null) target.runtimeId = runtimeId;

      target.turn = turn;
      target.history.push({
        role: 'user',
        content: restarted
          ? [
              { type: 'text', text: runtimeRestartedNote },
              { type: 'text', text },
            ]
          : text,
      });
      emit({ type: 'turn', principal, turn: publicTurn(turn) });

      if (restarted)
        notice(
          target,
          'info',
          'The runtime restarted since the last message; the agent was told earlier reads may be stale.',
        );

      upsert(target, {
        kind: 'user',
        id: randomUUID(),
        at: new Date().toISOString(),
        text,
      });
      turn.done = run(target, turn);

      return { turnId: turn.turnId, principal };
    },
    cancel(turnId) {
      for (const target of conversations.values()) {
        const turn = target.turn;

        if (turn?.turnId !== turnId) continue;

        if (turn.status === 'running') {
          turn.status = 'cancelling';
          emit({
            type: 'turn',
            principal: target.principal,
            turn: publicTurn(turn),
          });
          turn.controller.abort(new Error('Cancelled by the developer'));
        }

        return true;
      }

      return false;
    },
    reset(principal) {
      const target = conversations.get(principal);

      if (!target) {
        const declared = options.principals();

        if (!declared?.names.includes(principal))
          throw new AgentRequestError(
            404,
            `Unknown development principal '${principal}'`,
          );
      } else if (target.turn)
        throw new AgentRequestError(
          409,
          `A turn is running as '${principal}'; cancel it before starting a new conversation`,
        );

      conversations.delete(principal);
      emit({ type: 'reset', principal });

      return { principal };
    },
    async stop() {
      const running = [...conversations.values()].flatMap((target) =>
        target.turn ? [target.turn] : [],
      );

      for (const turn of running)
        turn.controller.abort(new Error('relate dev is stopping'));

      await Promise.all(running.map((turn) => turn.done));
    },
  };
}

const noStore = { 'Cache-Control': 'no-store' };

/**
 * `/dev/agent/*`: session-guarded like every inspector route, and behind the
 * dev server's Host/Origin guard. Turn changes also require the page's own
 * `Origin` and a JSON body, as the session exchange does.
 */
export function mountAgentRoutes(
  app: Hono,
  options: {
    readonly agent: Agent;
    readonly sessions: Sessions;
    readonly streams: SseStreams;
    readonly heartbeatMs: number;
  },
): void {
  const { agent } = options;
  const error = (c: Context, status: number, message: string) =>
    c.json({ error: message }, status as 400, noStore);
  const fromPage = (c: Context) => {
    const origin = c.req.header('origin');

    return (
      origin !== undefined &&
      options.sessions.allowedOrigins.includes(origin) &&
      (c.req.header('content-type') ?? '').startsWith('application/json')
    );
  };

  app.use('/dev/agent/*', options.sessions.requireSession);

  app.get('/dev/agent/conversations', (c) =>
    c.json(agent.snapshot(), 200, noStore),
  );

  app.get('/dev/agent/events', (c) =>
    streamJson<AgentEvent>(c, {
      streams: options.streams,
      heartbeatMs: options.heartbeatMs,
      subscribe(send) {
        const subscription = agent.subscribe(send);

        return {
          initial: subscription.snapshot,
          unsubscribe: subscription.unsubscribe,
        };
      },
    }),
  );

  app.post('/dev/agent/turns', async (c) => {
    if (!fromPage(c))
      return error(c, 403, 'Turns must come from the inspector page as JSON');

    let body: unknown;

    try {
      body = await c.req.json();
    } catch {
      return error(c, 400, 'Expected JSON');
    }

    const parsed = agentTurnRequestSchema.safeParse(body);

    if (!parsed.success)
      return error(
        c,
        400,
        `Invalid turn: ${parsed.error.issues
          .map(
            (issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`,
          )
          .join('; ')}`,
      );

    try {
      return c.json(
        agent.send(parsed.data.principal, parsed.data.text),
        202,
        noStore,
      );
    } catch (failure) {
      if (failure instanceof AgentRequestError)
        return error(c, failure.status, failure.message);

      throw failure;
    }
  });

  app.post('/dev/agent/conversations/:principal/reset', (c) => {
    if (!fromPage(c))
      return error(c, 403, 'Reset must come from the inspector page as JSON');

    try {
      return c.json(agent.reset(c.req.param('principal')), 202, noStore);
    } catch (failure) {
      if (failure instanceof AgentRequestError)
        return error(c, failure.status, failure.message);

      throw failure;
    }
  });

  app.post('/dev/agent/turns/:turnId/cancel', (c) => {
    if (!fromPage(c))
      return error(c, 403, 'Cancel must come from the inspector page as JSON');

    const turnId = c.req.param('turnId');
    const principal = agent
      .snapshot()
      .conversations.find((entry) => entry.turn?.turnId === turnId)?.principal;

    if (!principal || !agent.cancel(turnId))
      return error(c, 404, 'No such running turn');

    return c.json(
      { turnId, principal } satisfies AgentTurnAccepted,
      202,
      noStore,
    );
  });
}
