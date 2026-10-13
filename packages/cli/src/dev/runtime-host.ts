/**
 * Runtime host child: one per accepted build. Imports the accepted bundle,
 * calls `startApp(app)` unchanged (so `setup`, connectors and the application's
 * chosen store run exactly as in production) and answers graph operations and
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
 * apps/inspector/SPEC.md, "Live runtime, MCP and the built-in agent".
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

  return new Promise((resolve) => {
    process.send!(message, () => resolve());
  });
}

let failedReported = false;

async function fail(diagnostics: Diagnostic[]): Promise<never> {
  if (!failedReported) {
    failedReported = true;
    await send({ type: 'failed', runtimeId: args.runtimeId, diagnostics });
  }

  process.exit(1);
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
let relate: Relate;

try {
  relate = await node.startApp(observed);
} catch (error) {
  await fail([
    runtimeDiagnostic(
      'runtime.setup-failed',
      `Starting the application failed: ${sanitizeMessage(error)}${
        selected!.kind === 'graph'
          ? '. The config exports a graph without an app, so there is no setup to supply connections; export defineApp({ graph, setup }) to run it.'
          : ''
      }`,
      error,
    ),
  ]);
}

// A persistent store keeps its own revision check. Run it now so a model
// change reports a diagnostic at startup; never reset data to recover.
if (store) {
  try {
    await store.install(graphId, model!.definitionRevision);
  } catch (error) {
    await relate!.close().catch(() => {});
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

const principals = model!.principals ?? {};
const bound = new Map<string, ConsumerOperations>();
let retiring = false;

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

async function answer(request: RuntimeRequest): Promise<void> {
  if (request.type === 'close') {
    retiring = true;
    // close() rejects new operations and awaits in-flight ones; the dev
    // server kills this process if draining outlives its deadline.
    await relate!.close().catch(() => {});
    process.exit(0);
  }

  const operation = request.type === 'op' ? request.operation : 'discovery';

  try {
    if (retiring || request.runtimeId !== args.runtimeId)
      throw retiredError(operation);

    const operations = operationsFor(request.principal);

    // Names are checked by the dev server too; an unknown one is a bad request.
    if (!operations)
      throw operation === 'invoke' || operation === 'getReceipt'
        ? new ActionError('invalid')
        : new ReadError('invalid-request');

    const value =
      request.type === 'discovery'
        ? discover(operations)
        : await (
            operations[request.operation] as (
              ...input: unknown[]
            ) => Promise<unknown>
          )(...request.args);

    await send({ type: 'reply', id: request.id, value });
  } catch (error) {
    await send({ type: 'error', id: request.id, error: encodeError(error) });
  }
}

process.on('message', (raw) => {
  const parsed = runtimeRequestSchema.safeParse(raw);

  if (parsed.success) void answer(parsed.data);
});
// The dev server going away ends this runtime.
process.on('disconnect', () => {
  void relate!.close().finally(() => process.exit(0));
});

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
