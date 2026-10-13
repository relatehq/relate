/**
 * `/mcp`: the two `@relate/mcp` tools over Streamable HTTP, bound to the
 * active runtime host as a development principal.
 *
 *   POST /mcp?as=alice
 *   Authorization: Bearer <token printed by relate dev>
 *
 * MCP clients are not browsers: the inspector session cookie does not apply,
 * a bearer token does, and any request carrying a browser `Origin` is
 * refused. The dev server's Host validation still runs first. `?as` selects a
 * declared principal (the default when absent); an undeclared one is a 404.
 * Only then is the request observed as activity. When the runtime cannot
 * serve the principal, tool calls fail at once with the reason, as a
 * `BindingUnavailableError` the caller sees.
 */
import { randomBytes } from 'node:crypto';
import { chmod, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  BindingUnavailableError,
  createDevelopmentExecutor,
  createStreamableHttpHandler,
} from '@relate/mcp';
import type { CodeExecutor, GraphBinding } from '@relate/mcp';
import { ReadError } from '@relate/protocol';
import {
  observeExecutor,
  observeRequest,
  type ActivityLog,
} from './activity/index.js';
import type { RuntimeBinding } from './runtime-binding.js';
import { RuntimeUnavailableError } from './runtime-controller.js';
import { constantTimeEqual } from './session.js';

export interface McpEndpointOptions {
  /** 256-bit bearer token; see `readMcpToken` for keeping it per project. */
  readonly token: string;
  /** Null with `relate dev --no-runtime`. */
  readonly runtime: {
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
  readonly token: string;
  handle(request: Request): Promise<Response>;
}

const noStore = { 'Cache-Control': 'no-store' };
const tokenPattern = /^[A-Za-z0-9_-]{43}$/;

export function createMcpToken(): string {
  return randomBytes(32).toString('base64url');
}

/**
 * The project's MCP token, kept in `<dir>/mcp-token` (owner-only) so a saved
 * `claude mcp add` entry survives `relate dev` restarts. A missing or invalid
 * file, or `rotate`, issues a new one. The directory gets a `.gitignore` so
 * the token is never committed.
 */
export async function readMcpToken(
  directory: string,
  options: { readonly rotate?: boolean } = {},
): Promise<{ readonly token: string; readonly created: boolean }> {
  const path = join(directory, 'mcp-token');

  if (!options.rotate) {
    try {
      const existing = (await readFile(path, 'utf8')).trim();

      if (tokenPattern.test(existing)) {
        await chmod(path, 0o600);

        return { token: existing, created: false };
      }
    } catch {
      // Missing or unreadable: issue a new one.
    }
  }

  const token = createMcpToken();

  await writeFile(join(directory, '.gitignore'), '*\n');
  await writeFile(path, `${token}\n`, { mode: 0o600 });
  await chmod(path, 0o600);

  return { token, created: true };
}

/** The ready-to-paste command for Claude Code. */
export function mcpAddCommand(url: string, token: string): string {
  return `claude mcp add --transport http relate "${url}" --header "Authorization: Bearer ${token}"`;
}

/** The runtime's own reason, as a public error; nothing else reaches the caller. */
function unavailable(error: unknown): BindingUnavailableError {
  if (error instanceof RuntimeUnavailableError)
    return new BindingUnavailableError(error.message, {
      retryable: error.retryable,
    });

  if (error instanceof ReadError && error.code === 'runtime-retired')
    return new BindingUnavailableError(
      'The runtime restarted while binding; retry',
      { retryable: true },
    );

  return new BindingUnavailableError(
    `Could not read discovery from the runtime: ${
      error instanceof Error ? error.message : String(error)
    }`,
    { retryable: false },
  );
}

export function createMcpEndpoint(options: McpEndpointOptions): McpEndpoint {
  const { token } = options;
  const executor = options.executor ?? createDevelopmentExecutor();
  const json = (status: number, error: string, headers = {}) =>
    Response.json({ error }, { status, headers: { ...noStore, ...headers } });

  if (!tokenPattern.test(token))
    throw new Error('The MCP token must be 32 random bytes in base64url');

  return {
    token,
    async handle(request) {
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

      return observeRequest(options.activity, request, async (call) => {
        let binding: RuntimeBinding | null = null;
        let failure: BindingUnavailableError | null = null;

        if (!options.runtime)
          failure = new BindingUnavailableError(
            'The runtime is off (relate dev --no-runtime)',
            { retryable: false },
          );
        else if (principal === null)
          failure = new BindingUnavailableError(
            'No model has compiled yet; fix the errors shown by relate dev',
            { retryable: true },
          );
        else
          try {
            binding = await options.runtime.binding(principal);
          } catch (error) {
            failure = unavailable(error);
          }

        call.begin({
          runtimeId: binding?.runtimeId ?? null,
          principal,
          source: 'external',
          ...(failure ? { unavailable: failure.message } : {}),
        });

        const graph: GraphBinding | null = binding && {
          description: binding.description,
          operations: binding.operations,
        };

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
          bindGraph: () => {
            if (!graph) throw failure!;

            return graph;
          },
        })(request);
      });
    },
  };
}
