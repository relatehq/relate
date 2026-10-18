/**
 * Runtime host child: one per accepted build. Imports the accepted bundle,
 * calls `startApp(app)` unchanged (so `setup`, connectors and the application's
 * chosen store run exactly as in production), optionally runs the config's
 * seed export against that runtime, and answers graph operations and
 * discovery over IPC for one `runtimeId`. It has no HTTP listener and knows
 * nothing about MCP or HTTP; the dev server owns every transport.
 *
 * `ANTHROPIC_API_KEY` is withheld from this process: user code never sees the
 * built-in agent's key.
 *
 * Possible later direction (not planned): if graphs are deployed to a
 * Relate-hosted cloud with the inspector as their UI, this process is the seed
 * of that hosted runtime. Keep its IPC contract in public protocol shapes and
 * its lifecycle explicit so it can grow, but do not build for it now. See
 * specs/2026-10-07-inspector.md, "Live runtime, MCP and the built-in agent".
 */
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { AppDefinition, GraphDefinition, ObjectRegistry } from 'relate';
import type { ObservationStore } from 'relate/storage';
import { ActionError, ReadError } from '@relate/protocol';
import type { ConsumerOperations } from '@relate/protocol';
import type { Diagnostic } from '@relate/inspector/protocol';
import {
  createChildSupport,
  isCompileError,
  sanitizeMessage,
  selectExport,
} from './child-support.js';
import {
  decodeRuntimeHostArguments,
  encodeError,
  retiredError,
  runtimeRequestSchema,
  withheldVariables,
  type DiscoverySnapshot,
  type RuntimeMessage,
  type RuntimeRequest,
} from './runtime-protocol.js';

type CompilerModule = typeof import('relate/compiler');

type NodeModule = typeof import('@relate/node');

type App = AppDefinition<
  GraphDefinition & { readonly objects: ObjectRegistry }
>;

type Relate = Awaited<ReturnType<NodeModule['startApp']>>;

for (const name of withheldVariables) delete process.env[name];

const args = decodeRuntimeHostArguments(process.argv[2]);
const support = createChildSupport({
  ...args,
  childFile: fileURLToPath(import.meta.url),
});

function send(message: RuntimeMessage): Promise<void> {
  if (!process.send) {
    process.stderr.write('relate dev runtime host started without IPC\n');
    process.exit(1);
  }

  // The dev server is gone; there is nobody left to tell.
  if (!process.connected) return Promise.resolve();

  return new Promise((resolve) => {
    process.send!(message, () => resolve());
  });
}

let relate: Relate | undefined;
/** Set once startup has passed its last shutdown check. */
let started = false;
let shuttingDown = false;
/** Requests being answered, including sending the reply. */
const answering = new Set<Promise<void>>();

/**
 * Close and exit. Runs after startup so `onDispose` cleanup always runs;
 * `close()` drains in-flight operations, then their replies are sent before
 * the process exits.
 */
async function closeAndExit(): Promise<never> {
  if (failure) return failure;

  // New requests are already refused. Settle in-flight ones, wait for their
  // operation rows to be appended, and forward their activity while the
  // runtime can still be read; `close()` then drains anything later.
  await Promise.allSettled(answering);
  await relate?.host.flushActivity().catch(() => {});
  await forwardActivity(true);
  await relate?.close().catch(() => {});
  await Promise.allSettled(answering);

  if (failure) return failure;

  process.exit(0);
}

/**
 * A `close` from the dev server, or the dev server going away. Startup
 * finishes first (it checks `shuttingDown`); the deadline bounds a setup or
 * cleanup that never settles, also when nobody is left to kill this process.
 */
function shutdown(): void {
  if (shuttingDown) return;

  shuttingDown = true;
  setTimeout(() => process.exit(1), args.drainTimeoutMs);

  if (started) void closeAndExit();
}

let failure: Promise<never> | undefined;

function fail(diagnostics: Diagnostic[]): Promise<never> {
  if (failure) return failure;

  shuttingDown = true;
  failure = (async () => {
    let reported: Promise<never> | undefined;
    const report = () =>
      (reported ??= (async () => {
        await send({ type: 'failed', runtimeId: args.runtimeId, diagnostics });
        process.exit(1);
      })());
    // The parent kills failed hosts immediately. Dispose first, but retain a
    // deadline for stuck operations or disposers, including after startup.
    const deadline = setTimeout(() => void report(), args.drainTimeoutMs);

    await relate?.close().catch(() => {});
    clearTimeout(deadline);

    return report();
  })();

  return failure;
}

function runtimeDiagnostic(
  code: string,
  message: string,
  error?: unknown,
): Diagnostic {
  const site = support.userSite(
    error instanceof Error ? error.stack : undefined,
    'expression',
  );

  return {
    kind: 'runtime',
    code,
    severity: 'error',
    message,
    ...(site ? { site } : {}),
  };
}

process.on('uncaughtException', (error) => {
  void fail([
    runtimeDiagnostic(
      'runtime.uncaught',
      `The runtime host stopped on an uncaught exception: ${sanitizeMessage(error)}`,
      error,
    ),
  ]);
});
process.on('unhandledRejection', (error) => {
  void fail([
    runtimeDiagnostic(
      'runtime.unhandled-rejection',
      `The runtime host stopped on an unhandled rejection: ${sanitizeMessage(error)}`,
      error,
    ),
  ]);
});

// Registered before any user code runs, so a close or a departed dev server
// during a slow setup is never missed.
process.on('message', (raw) => {
  const parsed = runtimeRequestSchema.safeParse(raw);

  if (!parsed.success) return;

  if (parsed.data.type === 'close') {
    shutdown();

    return;
  }

  const answer = respond(parsed.data);

  answering.add(answer);
  void answer.finally(() => answering.delete(answer));
});
process.on('disconnect', shutdown);

/** The project's own packages, so definitions and the runtime share one `relate`. */
async function loadPackages(): Promise<{
  compiler: CompilerModule;
  node: NodeModule;
}> {
  const compilerEntry = support.packageEntry('relate', './compiler');
  const nodeEntry = support.packageEntry('@relate/node', '.');

  return {
    compiler: compilerEntry
      ? ((await import(pathToFileURL(compilerEntry).href)) as CompilerModule)
      : await import('relate/compiler'),
    node: nodeEntry
      ? ((await import(pathToFileURL(nodeEntry).href)) as NodeModule)
      : await import('@relate/node'),
  };
}

const { compiler, node } = await loadPackages();
let module: Record<string, unknown>;

if (shuttingDown) await closeAndExit();

try {
  module = (await import(pathToFileURL(args.bundlePath).href)) as Record<
    string,
    unknown
  >;
} catch (error) {
  await fail([
    runtimeDiagnostic(
      'runtime.import-failed',
      `The runtime host could not import the application: ${sanitizeMessage(error)}`,
      error,
    ),
  ]);
}

const selected = selectExport(module!);

if (!selected)
  await fail([
    runtimeDiagnostic(
      'runtime.no-definition',
      `${support.projectRelative(args.configPath)} no longer exports an application`,
    ),
  ]);

if (args.seed && typeof module!.seed !== 'function')
  await fail([
    runtimeDiagnostic(
      'runtime.seed-missing',
      `--seed requires ${support.projectRelative(args.configPath)} to export a function named seed: export async function seed(relate) { ... }`,
    ),
  ]);

const app = (
  selected!.kind === 'app'
    ? selected!.app
    : { kind: 'relate.app', graph: selected!.graph }
) as App;
let model: ReturnType<CompilerModule['compile']>;

try {
  model = compiler.compile(app.graph);
} catch (error) {
  await fail([
    runtimeDiagnostic(
      'runtime.compile-failed',
      isCompileError(error)
        ? `The runtime host's compile failed: ${error.issues.map((issue) => issue.message).join('; ')}`
        : `The runtime host's compile threw: ${sanitizeMessage(error)}`,
    ),
  ]);
}

// Observe, never replace, the store `setup` chooses.
let store: ObservationStore | undefined;
let graphId = app.graph.id;
const observed: App = Object.freeze({
  ...app,
  ...(app.setup
    ? {
        setup: async (context: Parameters<NonNullable<App['setup']>>[0]) => {
          const bindings = await app.setup!(context);

          store = bindings.store;
          graphId = bindings.graphId ?? app.graph.id;

          return bindings;
        },
      }
    : {}),
});

if (shuttingDown) await closeAndExit();

try {
  relate = await node.startApp(observed);
} catch (error) {
  // A bare graph has no setup; when it needs bindings, there is nothing to run.
  if (selected!.kind === 'graph' && !args.seed) {
    await send({
      type: 'not-configured',
      runtimeId: args.runtimeId,
      diagnostics: [
        {
          kind: 'runtime',
          code: 'runtime.not-configured',
          severity: 'warning',
          message: `The config exports a graph without an app, so there is no setup to supply its connections (${sanitizeMessage(error)}). Export defineApp({ graph, setup }) to run it.`,
        },
      ],
    });
    process.exit(0);
  }

  await fail([
    runtimeDiagnostic(
      'runtime.setup-failed',
      `Starting the application failed${args.seed ? '; the requested seed could not run' : ''}: ${sanitizeMessage(error)}${selected!.kind === 'graph' ? '. Export defineApp({ graph, setup }) to supply connections before seeding.' : ''}`,
      error,
    ),
  ]);
}

if (shuttingDown) await closeAndExit();

// A persistent store keeps its own revision check. Run it now so a model
// change reports a diagnostic at startup; never reset data to recover. An
// empty store records this revision here, as the first operation would.
if (store) {
  try {
    await store.install(graphId, model!.definitionRevision);
  } catch (error) {
    await fail([
      error instanceof Error && error.name === 'StorageUnavailable'
        ? runtimeDiagnostic(
            'runtime.store-unavailable',
            "The application's store is unavailable, so the runtime could not start",
          )
        : runtimeDiagnostic(
            'runtime.store-revision-mismatch',
            `The application's persistent store holds a different model revision than ${model!.definitionRevision}. The runtime stays stopped and the store is left untouched; migrate or point setup at a fresh store. (${sanitizeMessage(error)})`,
          ),
    ]);
  }
}

if (shuttingDown) await closeAndExit();

if (args.seed) {
  try {
    await (module!.seed as (runtime: Relate) => unknown)(relate!);
  } catch (error) {
    // Successful writes already made by the seed are not rolled back.
    await fail([
      runtimeDiagnostic(
        'runtime.seed-failed',
        `Seeding the application failed: ${sanitizeMessage(error)}`,
        error,
      ),
    ]);
  }
}

if (shuttingDown) await closeAndExit();

const principals = model!.principals ?? {};
const bound = new Map<string, ConsumerOperations>();

function operationsFor(principal: string): ConsumerOperations | undefined {
  if (!Object.hasOwn(principals, principal)) return undefined;

  let operations = bound.get(principal);

  if (!operations) {
    const definition = principals[principal]!;

    operations = relate!.operations({
      id: principal,
      roles: definition.roles,
      claims: definition.claims,
    });
    bound.set(principal, operations);
  }

  return operations;
}

/**
 * Forward the runtime's own records of this runtime's dev requests (rows
 * whose context names this `runtimeId`) to the dev server, which projects
 * them onto the activity log. Best effort and never part of a write: a missed
 * pass loses display rows only, and the store's feed stays authoritative.
 *
 * Passes run for about a second after each operation, because operation rows
 * are appended asynchronously after the call settles. The feed is read from
 * its checkpoint; operations newest first down to the previous pass's
 * watermark, since this runtime's single writer records them in order.
 */
const forwarding = {
  enabled: false,
  /** Feed entries from before this host started are never ours. */
  feedFrom: '',
  feedCursor: undefined as string | undefined,
  /** Newest `recordedAt` seen (epoch ms), and the IDs seen at or after it. */
  since: 0,
  seen: new Map<string, number>(),
  pass: undefined as Promise<void> | undefined,
  remaining: 0,
  timer: undefined as NodeJS.Timeout | undefined,
};

type Activity = Relate['host']['activity'];

type FeedRow = Awaited<ReturnType<Activity['feed']['read']>>['entries'][number];

type OperationRow = Awaited<
  ReturnType<Activity['operations']['list']>
>['entries'][number];

const ours = (row: FeedRow | OperationRow) =>
  row.context.runtimeId === args.runtimeId;

async function forwardPass(): Promise<void> {
  const activity = relate!.host.activity;
  const feed: FeedRow[] = [];
  const operations: OperationRow[] = [];

  try {
    for (let more = true; more;) {
      const page = await activity.feed.read(
        forwarding.feedCursor
          ? { cursor: forwarding.feedCursor, limit: 200 }
          : { filter: { from: forwarding.feedFrom }, limit: 200 },
      );

      forwarding.feedCursor = page.nextCursor;
      more = page.hasMore;
      feed.push(...page.entries.filter(ours));
    }
  } catch (error) {
    // Eviction passed the checkpoint: resume from what is retained.
    if ((error as { code?: unknown }).code === 'cursor-expired')
      forwarding.feedCursor = undefined;
  }

  let newest = forwarding.since;
  let scanned = false;

  try {
    let cursor: string | undefined;

    scan: for (;;) {
      const page = await activity.operations.list(
        cursor ? { cursor, limit: 100 } : { limit: 100 },
      );

      for (const row of page.entries) {
        const at = Date.parse(row.recordedAt);

        if (at < forwarding.since) break scan;

        newest = Math.max(newest, at);

        if (forwarding.seen.has(row.id)) continue;

        forwarding.seen.set(row.id, at);

        if (ours(row)) operations.push(row);
      }

      if (!page.hasMore) break;

      cursor = page.nextCursor;
    }

    scanned = true;
  } catch {
    // Operation rows are best effort; the next pass resumes at the watermark.
  }

  // A partial scan keeps the old watermark so unread older rows are revisited;
  // `seen` already holds the rows forwarded from it.
  if (scanned) {
    forwarding.since = newest;

    for (const [id, at] of forwarding.seen)
      if (at < newest) forwarding.seen.delete(id);
  }

  if (feed.length || operations.length)
    await send({
      type: 'activity',
      runtimeId: args.runtimeId,
      feed,
      operations,
    } as unknown as RuntimeMessage);
}

/** One pass at a time; `final` waits for a pass in flight, then runs one more. */
function forwardActivity(final = false): Promise<void> {
  if (!forwarding.enabled) return Promise.resolve();

  const run = () =>
    (forwarding.pass ??= forwardPass()
      .catch(() => {})
      .finally(() => {
        forwarding.pass = undefined;
      }));

  return final ? (forwarding.pass ?? Promise.resolve()).then(run) : run();
}

/** Keep forwarding for about a second after the latest operation. */
function scheduleForwarding(): void {
  if (!forwarding.enabled) return;

  forwarding.remaining = 10;
  forwarding.timer ??= setInterval(() => {
    void forwardActivity();

    if (--forwarding.remaining <= 0) {
      clearInterval(forwarding.timer);
      forwarding.timer = undefined;
    }
  }, 100);
  forwarding.timer.unref();
}

/**
 * Rows of earlier hosts (a seed, history in a persistent store) never name
 * this host's fresh `runtimeId`, so they are skipped, not forwarded. The
 * operation watermark starts at the newest existing row, in the store's clock.
 */
async function startForwarding(): Promise<void> {
  const activity = relate!.host.activity;

  // Feed entries carry this process's clock; the filter keeps the first pass
  // from paging through every retained entry of earlier hosts.
  forwarding.feedFrom = new Date().toISOString();

  try {
    if ((await activity.status()).state !== 'available') return;

    const [newest] = (await activity.operations.list({ limit: 1 })).entries;

    if (newest) {
      forwarding.since = Date.parse(newest.recordedAt);
      forwarding.seen.set(newest.id, forwarding.since);
    }

    forwarding.enabled = true;
  } catch {
    // Without readable activity the Inspector shows dispatch events only.
  }
}

function discover(operations: ConsumerOperations): DiscoverySnapshot {
  const overview = operations.discovery.describe();
  const objects: Record<string, DiscoverySnapshot['objects'][string]> = {};
  const actions: Record<string, DiscoverySnapshot['actions'][string]> = {};

  for (const name of Object.keys(overview.objects)) {
    const route = model!.consumer.objects[name];
    const detail = route
      ? operations.discovery.describeObject(route.definitionId)
      : undefined;

    if (detail) objects[detail.definitionId] = detail;
  }

  for (const name of Object.keys(overview.actions)) {
    const route = (
      model!.consumer.actions as Record<string, { definitionId: string }>
    )[name];
    const detail = route
      ? operations.discovery.describeAction(route.definitionId)
      : undefined;

    if (detail) actions[detail.definitionId] = detail;
  }

  return { overview, objects, actions };
}

async function respond(
  request: Exclude<RuntimeRequest, { type: 'close' }>,
): Promise<void> {
  const operation = request.type === 'op' ? request.operation : 'discovery';

  try {
    if (shuttingDown || request.runtimeId !== args.runtimeId)
      throw retiredError(operation);

    // The dev server sends nothing before `ready`.
    if (!started)
      throw operation === 'invoke' || operation === 'getReceipt'
        ? new ActionError('unavailable')
        : new ReadError('unavailable');

    const operations = operationsFor(request.principal);

    // Names are checked by the dev server too; an unknown one is a bad request.
    if (!operations)
      throw operation === 'invoke' || operation === 'getReceipt'
        ? new ActionError('invalid')
        : new ReadError('invalid-request');

    const definition = principals[request.principal]!;
    const value =
      request.type === 'discovery'
        ? discover(operations)
        : request.attempt
          ? // The runtime records the operation under the dev binding's ID.
            await relate!.host.dispatch(
              {
                id: request.principal,
                roles: definition.roles,
                claims: definition.claims,
              },
              {
                operationId: request.attempt.operationId,
                context: {
                  requestId: request.attempt.context.requestId,
                  transport: request.attempt.context.transport,
                  runtimeId: request.attempt.context.runtimeId,
                  ...(request.attempt.context.executionId
                    ? { executionId: request.attempt.context.executionId }
                    : {}),
                },
              },
              request.operation,
              request.args,
            )
          : await (
              operations[request.operation] as (
                ...input: unknown[]
              ) => Promise<unknown>
            )(...request.args);

    await send({ type: 'reply', id: request.id, value });
  } catch (error) {
    await send({ type: 'error', id: request.id, error: encodeError(error) });
  } finally {
    if (request.type === 'op') scheduleForwarding();
  }
}

await startForwarding();
started = true;
await send({
  type: 'ready',
  runtimeId: args.runtimeId,
  definitionRevision: model!.definitionRevision,
  store: store ? 'application' : 'memory',
  principals: Object.keys(principals),
  consumer: model!.consumer as unknown as Extract<
    RuntimeMessage,
    { type: 'ready' }
  >['consumer'],
});
