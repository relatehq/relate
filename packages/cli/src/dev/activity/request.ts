/**
 * L1: observe one authenticated transport request. Only tool calls are
 * recorded; MCP handshakes and tool listings are not activity. Call this after
 * authentication, so an unauthenticated body is never buffered or parsed. The
 * handler decides which runtime serves the caller, then begins the call; the
 * observer finishes it from the response.
 */
import { randomUUID } from 'node:crypto';
import type { CallEvent } from '@relate/inspector/protocol';
import { activityLimits, truncate, type ActivityLog } from './log.js';

export type CallTool = CallEvent['tool'];
export type CallSource = CallEvent['source'];

export interface CallObservation {
  readonly requestId: string;
  /** The tool this request calls, or null when it is not a tool call. */
  readonly tool: CallTool | null;
  /**
   * Record the call. `unavailable` explains why it could not reach a runtime;
   * such a call fails with that reason.
   */
  begin(call: {
    readonly runtimeId: string | null;
    readonly principal: string | null;
    readonly source: CallSource;
    readonly unavailable?: string;
  }): void;
}

const tools: readonly string[] = ['discover', 'execute'];

/** The tool named by a single JSON-RPC `tools/call`; never consumes the original body. */
async function toolOf(request: Request): Promise<CallTool | null> {
  if (request.method !== 'POST') return null;

  try {
    const message = (await request.clone().json()) as {
      method?: unknown;
      params?: { name?: unknown };
    };

    return message.method === 'tools/call' &&
      typeof message.params?.name === 'string' &&
      tools.includes(message.params.name)
      ? (message.params.name as CallTool)
      : null;
  } catch {
    return null;
  }
}

/** A JSON-RPC error or a tool result flagged `isError`. */
async function failed(response: Response): Promise<string | null> {
  if (!response.ok) return `HTTP ${response.status}`;

  try {
    const message = (await response.clone().json()) as {
      error?: { message?: unknown };
      result?: {
        isError?: unknown;
        structuredContent?: { error?: { code?: unknown } };
      };
    };

    if (message.error)
      return typeof message.error.message === 'string'
        ? message.error.message
        : 'JSON-RPC error';

    if (message.result?.isError === true) {
      const code = message.result.structuredContent?.error?.code;

      return typeof code === 'string' ? code : 'tool error';
    }

    return null;
  } catch {
    return null;
  }
}

export async function observeRequest(
  log: ActivityLog,
  request: Request,
  handle: (call: CallObservation) => Promise<Response>,
): Promise<Response> {
  const tool = await toolOf(request);
  const started = performance.now();
  let begun: Omit<CallEvent, 'status' | 'ms' | 'error'> | null = null;
  let unavailable: string | undefined;
  const call: CallObservation = {
    requestId: randomUUID(),
    tool,
    begin(details) {
      if (!tool || begun) return;

      unavailable = details.unavailable;
      begun = {
        kind: 'call',
        requestId: call.requestId,
        runtimeId: details.runtimeId,
        source: details.source,
        principal: details.principal,
        tool,
        at: new Date().toISOString(),
      };
      log.record({ ...begun, status: 'running' });
    },
  };
  const finish = (error: string | null) => {
    if (!begun) return;

    log.record({
      ...begun,
      status: error === null ? 'succeeded' : 'failed',
      ms: performance.now() - started,
      ...(error === null
        ? {}
        : { error: truncate(error, activityLimits.preview).text }),
    });
  };

  try {
    const response = await handle(call);

    finish(unavailable ?? (await failed(response)));

    return response;
  } catch (error) {
    finish(error instanceof Error ? error.message : 'Request failed');

    throw error;
  }
}
