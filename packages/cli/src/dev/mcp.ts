/**
 * `/mcp`: the two `@relate/mcp` tools over Streamable HTTP, bound to the
 * active runtime host as a development principal.
 *
 *   POST /mcp?as=alice
 *   Authorization: Bearer <token printed by relate dev>
 *
 * MCP clients are not browsers: the inspector session cookie does not apply,
 * a bearer token generated per dev server does, and any request carrying a
 * browser `Origin` is refused. The dev server's Host validation still runs
 * first. `?as` selects a declared principal (the default when absent); an
 * undeclared one is a 404. When no runtime is running, tool calls return a
 * clean tool error rather than waiting for one.
 */
import { randomBytes } from 'node:crypto';
import {
  createDevelopmentExecutor,
  createStreamableHttpHandler,
} from '@relate/mcp';
import type { CodeExecutor, GraphBinding } from '@relate/mcp';
import type { RuntimeStatus } from '@relate/inspector/protocol';
import {
  observeExecutor,
  observeRequests,
  type ActivityLog,
} from './activity/index.js';
import type { RuntimeBinding } from './runtime-binding.js';
import { constantTimeEqual } from './session.js';

export interface McpEndpointOptions {
  /** Null with `relate dev --no-runtime`. */
  readonly runtime: {
    readonly status: RuntimeStatus | null;
    binding(principal: string): Promise<RuntimeBinding>;
  } | null;
  /** The accepted model's principals, or null before the first model. */
  readonly principals: () => {
    readonly names: readonly string[];
    readonly defaultPrincipal: string | null;
  } | null;
  readonly activity: ActivityLog;
  /** Default: `createDevelopmentExecutor()`, a fresh Node child per call. */
  readonly executor?: CodeExecutor;
}

export interface McpEndpoint {
  /** 256-bit bearer token for this dev server; printed in the terminal. */
  readonly token: string;
  handle(request: Request): Promise<Response>;
}

const noStore = { 'Cache-Control': 'no-store' };

/** The ready-to-paste command for Claude Code. */
export function mcpAddCommand(url: string, token: string): string {
  return `claude mcp add --transport http relate "${url}" --header "Authorization: Bearer ${token}"`;
}

/** Why a declared principal cannot be served right now. */
function unavailableReason(status: RuntimeStatus | null): string {
  switch (status?.state) {
    case 'starting':
    case 'restarting':
      return 'The runtime is restarting; retry shortly';
    case 'failed':
      return 'The runtime failed; see the runtime diagnostics in relate dev';
    case 'not-configured':
      return 'The runtime is not configured; export defineApp with setup to run it';
    default:
      return 'The runtime is not running';
  }
}

/**
 * A binding with no runtime behind it. `@relate/mcp` turns its throwing
 * discovery into a `binding` tool error for both tools, so the call ends
 * immediately instead of waiting for a runtime.
 */
function unavailableBinding(reason: string): GraphBinding {
  const fail = (): never => {
    throw new Error(reason);
  };
  const reject = () => Promise.reject(new Error(reason));

  return {
    description: {
      formatVersion: 1,
      graphDefinitionId: 'unavailable',
      definitionRevision: 'unavailable',
      objects: {},
      actions: {},
    },
    operations: {
      discovery: { describe: fail, describeObject: fail, describeAction: fail },
      get: reject,
      query: reject,
      traverse: reject,
      invoke: reject,
      getReceipt: reject,
    },
  };
}

export function createMcpEndpoint(options: McpEndpointOptions): McpEndpoint {
  const token = randomBytes(32).toString('base64url');
  const executor = options.executor ?? createDevelopmentExecutor();
  const json = (status: number, error: string, headers = {}) =>
    Response.json({ error }, { status, headers: { ...noStore, ...headers } });

  return {
    token,
    handle: observeRequests(options.activity, async (request, call) => {
      if (request.headers.has('origin'))
        return json(403, 'MCP does not accept browser requests');

      const supplied = /^Bearer (.+)$/i.exec(
        request.headers.get('authorization') ?? '',
      )?.[1];

      if (!supplied || !constantTimeEqual(supplied, token))
        return json(
          401,
          'Use the bearer token printed by relate dev: Authorization: Bearer <token>',
          { 'WWW-Authenticate': 'Bearer realm="relate-dev"' },
        );

      const requested = new URL(request.url).searchParams.get('as');
      const declared = options.principals();

      if (declared && requested !== null && !declared.names.includes(requested))
        return json(
          404,
          `Unknown development principal '${requested}'. Declared: ${
            declared.names.join(', ') || 'none'
          }`,
        );

      if (declared && declared.defaultPrincipal === null)
        return json(
          404,
          'This graph declares no development principals; add principals to defineGraph',
        );

      const principal = requested ?? declared?.defaultPrincipal ?? null;
      let binding: RuntimeBinding | null = null;
      let unavailable: string | undefined;

      if (!options.runtime)
        unavailable = 'The runtime is off (relate dev --no-runtime)';
      else if (principal === null) unavailable = 'No compiled model yet';
      else
        try {
          binding = await options.runtime.binding(principal);
        } catch {
          unavailable = unavailableReason(options.runtime.status);
        }

      call.begin({
        runtimeId: binding?.runtimeId ?? null,
        principal,
        source: 'external',
        ...(unavailable ? { unavailable } : {}),
      });

      const graph: GraphBinding = binding
        ? { description: binding.description, operations: binding.operations }
        : unavailableBinding(unavailable!);

      return createStreamableHttpHandler({
        executor: binding
          ? observeExecutor(executor, options.activity, {
              requestId: call.requestId,
              runtimeId: binding.runtimeId,
              definitionRevision: binding.definitionRevision,
              principal: binding.principal,
              transport: 'mcp',
            })
          : executor,
        bindGraph: () => graph,
      })(request);
    }),
  };
}
