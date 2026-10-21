/**
 * The inspector playground's `/dev/playground/*` routes.
 *
 *   GET  /dev/playground/discovery?as=alice     → PlaygroundDiscovery
 *   POST /dev/playground/runs  { principal, code } → PlaygroundRun
 *
 * A run is the MCP `execute` contract without MCP: an async JavaScript
 * function body with `graph` injected for one development principal, run by
 * the same `CodeExecutor` in a fresh child process. It is recorded in
 * Activity as a call from `inspector-playground`, with its execution and graph
 * operations linked under one request ID.
 *
 * Graph operations that fail with `ReadError` are also captured here, in the
 * dev server, with their full request issues. Code may catch the error, and
 * the execution error carries only its message, so this is how the editor can
 * place an issue on the code that caused it (`compute.<alias>.sql` with a SQL
 * location, once the runtime reports one).
 *
 * Discovery is the principal's own, so the editor never suggests an object,
 * property or dataset that principal cannot use.
 */
import { randomUUID } from 'node:crypto';
import type { Context, Hono } from 'hono';
import { createDevelopmentExecutor } from '@relate/mcp';
import type { CodeExecutor } from '@relate/mcp';
import { ReadError } from '@relate/protocol';
import type { ConsumerOperations } from '@relate/protocol';
import {
  playgroundRunRequestSchema,
  type OperationContext,
  type PlaygroundDiscovery,
  type PlaygroundOperationError,
  type PlaygroundRead,
  type PlaygroundRun,
} from '@relate/inspector/protocol';
import {
  activityLimits,
  observeExecutor,
  truncate,
  type ActivityLog,
} from './activity/index.js';
import { bindingUnavailable } from './mcp.js';
import type { RuntimeBinding } from './runtime-binding.js';
import type { Sessions } from './session.js';

export interface PlaygroundOptions {
  /** Null with `relate dev --no-runtime`. */
  readonly runtime: {
    binding(principal: string): Promise<RuntimeBinding>;
  } | null;
  /** The accepted model's principals, or null before the first model. */
  readonly principals: () => { readonly names: readonly string[] } | null;
  readonly activity: ActivityLog;
  /** Default: `createDevelopmentExecutor()`, a fresh Node child per run. */
  readonly executor?: CodeExecutor;
}

export interface Playground {
  discovery(principal: string): Promise<PlaygroundDiscovery>;
  run(
    principal: string,
    code: string,
    signal?: AbortSignal,
  ): Promise<PlaygroundRun>;
}

export class PlaygroundRequestError extends Error {
  readonly status: 404 | 503;
  readonly retryable: boolean;

  constructor(status: 404 | 503, message: string, retryable = false) {
    super(message);
    this.name = 'PlaygroundRequestError';
    this.status = status;
    this.retryable = retryable;
  }
}

/** Operations that read objects; failures of these carry request issues. */
const reads = ['get', 'query', 'traverse'] as const;

/** IDs kept per read, enough to recognize which read a returned page came from. */
const readIdLimit = 200;

/** The IDs of the records a read returned: a page, or one found object. */
function returnedIds(value: unknown): string[] {
  const result = value as { data?: unknown; status?: unknown; id?: unknown };

  if (Array.isArray(result?.data))
    return result.data
      .slice(0, readIdLimit)
      .flatMap((record: { id?: unknown }) =>
        typeof record?.id === 'string' ? [record.id] : [],
      );

  return result?.status === 'ok' && typeof result.id === 'string'
    ? [result.id]
    : [];
}

/**
 * The same operations, recording each object read and each `ReadError` with
 * its issues. Errors are rethrown unchanged: the code sees what it would see
 * anywhere else. A read is recorded under the object its records belong to:
 * the traversal's target for `traverse`.
 */
function captureReads(
  operations: ConsumerOperations,
  description: RuntimeBinding['description'],
  record: {
    readonly reads: PlaygroundRead[];
    readonly errors: PlaygroundOperationError[];
  },
): ConsumerOperations {
  const routes = Object.entries(description.objects) as [
    string,
    {
      readonly definitionId: string;
      readonly traversals: Readonly<
        Record<string, { readonly target: string }>
      >;
    },
  ][];
  const apiName = (definitionId: string) =>
    routes.find(([, route]) => route.definitionId === definitionId)?.[0];
  const wrapped = { ...operations } as Record<string, unknown>;

  for (const operation of reads) {
    const inner = operations[operation] as (
      ...args: unknown[]
    ) => Promise<unknown>;

    wrapped[operation] = async (...args: unknown[]) => {
      const source = apiName(String(args[0])) ?? String(args[0]);
      const object =
        operation === 'traverse'
          ? routes.find(([name]) => name === source)?.[1].traversals[
              String(args[2])
            ]?.target
          : source;

      try {
        const value = await inner(...args);

        if (object)
          record.reads.push({ object, operation, ids: returnedIds(value) });

        return value;
      } catch (error) {
        if (error instanceof ReadError)
          record.errors.push({
            operation:
              error.operation ??
              `${source}.${operation}${operation === 'traverse' ? `.${String(args[2])}` : ''}`,
            code: error.code,
            issues: error.issues.map((issue) => ({ ...issue })),
          });

        throw error;
      }
    };
  }

  return Object.freeze(wrapped) as unknown as ConsumerOperations;
}

export function createPlayground(options: PlaygroundOptions): Playground {
  const executor = options.executor ?? createDevelopmentExecutor();

  const bind = async (principal: string): Promise<RuntimeBinding> => {
    const declared = options.principals();

    if (!declared)
      throw new PlaygroundRequestError(
        503,
        'No model has compiled yet; fix the errors shown by relate dev',
        true,
      );

    if (!declared.names.includes(principal))
      throw new PlaygroundRequestError(
        404,
        `Unknown development principal '${principal}'. Declared: ${
          declared.names.join(', ') || 'none'
        }`,
      );

    if (!options.runtime)
      throw new PlaygroundRequestError(
        503,
        'The runtime is off (relate dev --no-runtime)',
      );

    try {
      return await options.runtime.binding(principal);
    } catch (error) {
      // The same public reasons /mcp gives; nothing else reaches the page.
      const failure = bindingUnavailable(error);

      throw new PlaygroundRequestError(503, failure.message, failure.retryable);
    }
  };

  return {
    async discovery(principal) {
      const binding = await bind(principal);
      const { discovery } = binding.operations;
      const overview = discovery.describe();
      const objects: PlaygroundDiscovery['objects'] = {};

      for (const [apiName, route] of Object.entries(
        binding.description.objects,
      )) {
        const described = discovery.describeObject(route.definitionId);

        if (described && Object.hasOwn(overview.objects, apiName))
          objects[apiName] =
            described as unknown as PlaygroundDiscovery['objects'][string];
      }

      return {
        principal,
        runtimeId: binding.runtimeId,
        definitionRevision: binding.definitionRevision,
        overview: overview as unknown as PlaygroundDiscovery['overview'],
        objects,
      };
    },

    async run(principal, code, signal) {
      const requestId = randomUUID();
      const at = new Date().toISOString();
      const started = performance.now();
      let binding: RuntimeBinding;

      try {
        binding = await bind(principal);
      } catch (error) {
        if (!(error instanceof PlaygroundRequestError) || error.status === 404)
          throw error;

        const unbound = {
          kind: 'call' as const,
          requestId,
          runtimeId: null,
          source: 'inspector-playground' as const,
          principal,
          tool: 'execute' as const,
          at,
        };

        // The log opens an entry only on a start, so record one before the failure.
        options.activity.record({ ...unbound, status: 'running' });
        options.activity.record({
          ...unbound,
          status: 'failed',
          ms: performance.now() - started,
          error: truncate(error.message, activityLimits.preview).text,
        });

        return {
          requestId,
          principal,
          status: 'failed',
          error: {
            name: 'BindingUnavailableError',
            message: error.message,
            code: 'binding-unavailable',
          },
          logs: [],
          ms: performance.now() - started,
          reads: [],
          errors: [],
        };
      }

      const call = {
        kind: 'call' as const,
        requestId,
        runtimeId: binding.runtimeId,
        source: 'inspector-playground' as const,
        principal,
        tool: 'execute' as const,
        at,
      };
      const captured = {
        reads: [] as PlaygroundRead[],
        errors: [] as PlaygroundOperationError[],
      };
      const apiNames = new Map(
        Object.entries(binding.description.objects).map(([apiName, route]) => [
          route.definitionId,
          apiName,
        ]),
      );
      const observed = observeExecutor(
        executor,
        options.activity,
        {
          requestId,
          runtimeId: binding.runtimeId,
          definitionRevision: binding.definitionRevision,
          principal,
          // Operations reach the runtime host from the dev server process.
          transport: 'embedded',
        },
        (context: OperationContext) =>
          captureReads(
            binding.operationsFor(context),
            binding.description,
            captured,
          ),
      );

      options.activity.record({ ...call, status: 'running' });

      try {
        const result = await observed.execute({
          code,
          graph: {
            description: binding.description as Parameters<
              CodeExecutor['execute']
            >[0]['graph']['description'],
            operations: binding.operations,
          },
          ...(signal ? { signal } : {}),
        });
        const ms = performance.now() - started;

        options.activity.record({
          ...call,
          status: result.status,
          ms,
          ...(result.status === 'failed'
            ? {
                error: truncate(
                  result.error.code ?? result.error.name,
                  activityLimits.preview,
                ).text,
              }
            : {}),
        });

        return {
          requestId,
          principal,
          ...result,
          logs: [...result.logs],
          ms,
          reads: captured.reads,
          errors: captured.errors,
        };
      } catch (error) {
        options.activity.record({
          ...call,
          status: 'failed',
          ms: performance.now() - started,
          error: truncate(
            error instanceof Error ? error.message : String(error),
            activityLimits.preview,
          ).text,
        });

        throw error;
      }
    },
  };
}

const noStore = { 'Cache-Control': 'no-store' };

/**
 * `/dev/playground/*`: session-guarded like every inspector route. Runs also
 * require the page's own `Origin` and a JSON body, as agent turns do. Closing
 * the page's request aborts the run.
 */
export function mountPlaygroundRoutes(
  app: Hono,
  options: { readonly playground: Playground; readonly sessions: Sessions },
): void {
  const { playground } = options;
  const error = (c: Context, status: number, message: string, extra = {}) =>
    c.json({ error: message, ...extra }, status as 400, noStore);
  const refused = (c: Context, failure: unknown) => {
    if (failure instanceof PlaygroundRequestError)
      return error(c, failure.status, failure.message, {
        retryable: failure.retryable,
      });

    throw failure;
  };

  app.use('/dev/playground/*', options.sessions.requireSession);

  app.get('/dev/playground/discovery', async (c) => {
    const principal = c.req.query('as');

    if (!principal) return error(c, 400, 'Name a principal: ?as=<principal>');

    try {
      return c.json(await playground.discovery(principal), 200, noStore);
    } catch (failure) {
      return refused(c, failure);
    }
  });

  app.post('/dev/playground/runs', async (c) => {
    const origin = c.req.header('origin');

    if (
      origin === undefined ||
      !options.sessions.allowedOrigins.includes(origin) ||
      !(c.req.header('content-type') ?? '').startsWith('application/json')
    )
      return error(c, 403, 'Runs must come from the inspector page as JSON');

    let body: unknown;

    try {
      body = await c.req.json();
    } catch {
      return error(c, 400, 'Expected JSON');
    }

    const parsed = playgroundRunRequestSchema.safeParse(body);

    if (!parsed.success)
      return error(
        c,
        400,
        `Invalid run: ${parsed.error.issues
          .map(
            (issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`,
          )
          .join('; ')}`,
      );

    try {
      return c.json(
        await playground.run(
          parsed.data.principal,
          parsed.data.code,
          c.req.raw.signal,
        ),
        200,
        noStore,
      );
    } catch (failure) {
      return refused(c, failure);
    }
  });
}
