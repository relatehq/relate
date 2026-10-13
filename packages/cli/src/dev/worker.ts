/**
 * Application-loading child. Imports the bundled config, compiles its graph
 * and reports a model or structured failure over IPC. Replaced on every
 * attempt; it never starts the user's runtime.
 *
 * Runs with `--enable-source-maps`, so captured declaration stacks already
 * point at authored TypeScript when esbuild emitted a source map.
 */
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { GraphDefinition } from 'relate';
import type { ModelIssue, SourceSite } from 'relate/diagnostics';
import type { Diagnostic } from '@relate/inspector/protocol';
import {
  createChildSupport,
  isCompileError,
  sanitizeMessage,
  selectExport,
} from './child-support.js';
import {
  decodeWorkerArguments,
  type WorkerMessage,
} from './worker-protocol.js';

type RelateModule = typeof import('relate');

type CompilerModule = typeof import('relate/compiler');

const args = decodeWorkerArguments(process.argv[2]);
const support = createChildSupport({
  ...args,
  childFile: fileURLToPath(import.meta.url),
});
const { userSite, projectRelative } = support;

let reported = false;

function send(message: WorkerMessage): void {
  if (reported) return;

  reported = true;

  if (!process.send) {
    process.stderr.write('relate dev worker started without an IPC channel\n');
    process.exit(1);
  }

  process.send(message, () => process.exit(0));
}

async function loadRelate(): Promise<{
  relate: RelateModule;
  compiler: CompilerModule;
}> {
  const relateEntry = support.packageEntry('relate', '.');
  const compilerEntry = support.packageEntry('relate', './compiler');

  if (relateEntry && compilerEntry)
    return {
      relate: (await import(pathToFileURL(relateEntry).href)) as RelateModule,
      compiler: (await import(
        pathToFileURL(compilerEntry).href
      )) as CompilerModule,
    };

  return {
    relate: await import('relate'),
    compiler: await import('relate/compiler'),
  };
}

function importFailure(error: unknown, code: string): Diagnostic {
  const site = userSite(
    error instanceof Error ? error.stack : undefined,
    'expression',
  );

  return {
    kind: 'import',
    code,
    severity: 'error',
    message: sanitizeMessage(error),
    ...(site ? { site } : {}),
  };
}

type Definitions = Map<string, object>;

/** Every authored definition reachable from the graph, keyed by its stable ID. */
function collectDefinitions(graph: GraphDefinition): Definitions {
  const definitions: Definitions = new Map();
  const add = (id: unknown, definition: unknown) => {
    if (typeof id === 'string' && definition && typeof definition === 'object')
      if (!definitions.has(id)) definitions.set(id, definition);
  };

  add(graph.id, graph);

  for (const object of Object.values(graph.objects ?? {})) {
    add(object?.id, object);

    const membership = object?.membership as
      { resource?: { id?: string } } | undefined;

    if (membership && 'resource' in membership)
      add(membership.resource?.id, membership.resource);
  }

  for (const relationship of Object.values(graph.relationships ?? {}))
    add(relationship?.id, relationship);

  for (const action of Object.values(graph.actions ?? {}))
    add(action?.id, action);

  return definitions;
}

function resolveSites(
  relate: RelateModule,
  definitions: Definitions,
): Record<string, SourceSite> {
  const sites: Record<string, SourceSite> = {};

  for (const [id, definition] of definitions) {
    const site = userSite(
      relate.definitionProvenance(definition),
      'declaration',
    );

    if (site) sites[id] = site;
  }

  return sites;
}

function compileDiagnostics(
  issues: readonly ModelIssue[],
  sites: Readonly<Record<string, SourceSite>>,
): Diagnostic[] {
  return issues.map((issue) => {
    const site =
      issue.site ??
      (issue.definitionId ? sites[issue.definitionId] : undefined);

    return {
      kind: 'compile',
      severity: 'error',
      code: issue.code,
      message: issue.message,
      ...(issue.definitionId !== undefined
        ? { definitionId: issue.definitionId }
        : {}),
      ...(issue.path ? { path: issue.path } : {}),
      ...(site ? { site } : {}),
    };
  });
}

function selectGraph(
  module: Record<string, unknown>,
): GraphDefinition | undefined {
  const selected = selectExport(module);

  if (!selected) return undefined;

  return (
    selected.kind === 'app' ? selected.app.graph : selected.graph
  ) as GraphDefinition;
}

process.on('uncaughtException', (error) => {
  send({
    type: 'failure',
    diagnostics: [importFailure(error, 'import.uncaught')],
  });
});
process.on('unhandledRejection', (error) => {
  send({
    type: 'failure',
    diagnostics: [importFailure(error, 'import.unhandled-rejection')],
  });
});

const { relate, compiler } = await loadRelate();

relate.enableDefinitionProvenance();

let module: Record<string, unknown>;

try {
  module = (await import(pathToFileURL(args.bundlePath).href)) as Record<
    string,
    unknown
  >;
} catch (error) {
  // Early authoring validation throws structured issues during import.
  send({
    type: 'failure',
    diagnostics: isCompileError(error)
      ? compileDiagnostics(error.issues, {})
      : [importFailure(error, 'import.failed')],
  });
  throw error;
}

const graph = selectGraph(module);

if (!graph) {
  send({
    type: 'failure',
    diagnostics: [
      {
        kind: 'import',
        code: 'import.no-definition',
        severity: 'error',
        message: `${projectRelative(args.configPath)} must export defineApp({ graph, ... }) or a defineGraph(...) result as its default export`,
      },
    ],
  });
} else {
  const definitions = collectDefinitions(graph);
  const sites = resolveSites(relate, definitions);

  try {
    const model = compiler.compile(graph);

    send({
      type: 'model',
      manifest: model.manifest,
      definitionRevision: model.definitionRevision,
      principals: Object.keys(model.principals ?? {}),
      sites,
    });
  } catch (error) {
    send({
      type: 'failure',
      diagnostics: isCompileError(error)
        ? compileDiagnostics(error.issues, sites)
        : [
            {
              kind: 'worker',
              code: 'worker.exception',
              severity: 'error',
              message: `Compilation threw an unexpected error: ${sanitizeMessage(error)}`,
            },
          ],
    });
  }
}
