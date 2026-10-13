/**
 * Browser-safe development protocol between `relate dev` and the inspector.
 *
 * Shapes are typed and validated at runtime: the browser never trusts a payload
 * because it came over a local socket. This module depends on `relate/model`
 * and `relate/diagnostics` only, never on the compiler, runtime or Node APIs.
 */
import { z } from 'zod';
import { manifestSchema } from 'relate/model';
import type { Manifest } from 'relate/model';
import type { ModelIssue, SourceSite } from 'relate/diagnostics';

/** 2: model principals and the runtime host status. */
export const PROTOCOL_VERSION = 2 as const;

const text = z.string().min(1);
const identifierList = z.array(text).readonly();

export const sourceSiteSchema = z.strictObject({
  file: text,
  line: z.number().int().positive(),
  column: z.number().int().positive(),
  precision: z.enum(['declaration', 'expression']),
});

export const issuePathSchema = z.strictObject({
  root: z.enum(['graph', 'definition', 'manifest']),
  segments: z.array(z.union([z.string(), z.number().int()])).readonly(),
});

const frameSchema = sourceSiteSchema.extend({ excerpt: z.string() });
const severitySchema = z.enum(['error', 'warning']);
const presentation = {
  severity: severitySchema,
  frame: frameSchema.optional(),
};

/** Compile issues keep the full `ModelIssue` identity; codes stay open for newer validators. */
export const compileDiagnosticSchema = z.strictObject({
  kind: z.literal('compile'),
  code: text,
  message: z.string(),
  definitionId: text.optional(),
  path: issuePathSchema.optional(),
  site: sourceSiteSchema.optional(),
  ...presentation,
});

export const toolDiagnosticSchema = z.strictObject({
  kind: z.enum(['syntax', 'import', 'worker', 'layout', 'type', 'runtime']),
  code: text,
  message: z.string(),
  site: sourceSiteSchema.optional(),
  ...presentation,
});

export const diagnosticSchema = z.discriminatedUnion('kind', [
  compileDiagnosticSchema,
  toolDiagnosticSchema,
]);

export const modelSnapshotSchema = z.strictObject({
  generation: z.number().int().positive(),
  definitionRevision: text,
  manifest: manifestSchema,
  /** Development principal names in declaration order; never in the Manifest. */
  principals: identifierList,
  /** The first declared principal, or null when the graph declares none. */
  defaultPrincipal: text.nullable(),
});

/**
 * The runtime host started for an accepted model. `definitionRevision` is the
 * revision the running runtime serves, which can differ from the displayed
 * model's while a restart is in progress or after the runtime failed.
 */
export const runtimeStatusSchema = z.strictObject({
  /**
   * `not-configured`: the config exports a bare graph whose start needs
   * bindings only `defineApp` setup can supply. Neutral, not a failure.
   */
  state: z.enum([
    'starting',
    'restarting',
    'running',
    'not-configured',
    'failed',
  ]),
  runtimeId: text,
  /** The accepted model generation this runtime was started for. */
  generation: z.number().int().positive(),
  /** Active revision; null until the runtime reports ready. */
  definitionRevision: text.nullable(),
  /** `memory`: the runtime's own store, lost on every restart. */
  store: z.enum(['memory', 'application']).nullable(),
  /** The previous runtime's in-memory data was discarded by this restart. */
  dataReset: z.boolean(),
  diagnostics: z.array(diagnosticSchema).readonly(),
});

export const manifestDiffSchema = z.strictObject({
  objects: z.strictObject({
    added: identifierList,
    changed: identifierList,
    removed: identifierList,
  }),
  relationships: z.strictObject({
    added: identifierList,
    changed: identifierList,
    removed: identifierList,
  }),
  otherChanged: z.boolean(),
});

const failureSchema = z.strictObject({
  attempt: z.number().int().positive(),
  diagnostics: z.array(diagnosticSchema).readonly(),
});

const typecheckSchema = z.strictObject({
  revision: z.number().int().nonnegative(),
  diagnostics: z.array(diagnosticSchema).readonly(),
});

const envelope = {
  protocolVersion: z.literal(PROTOCOL_VERSION),
  instanceId: text,
  sequence: z.number().int().nonnegative(),
};

export const devEventSchema = z.discriminatedUnion('type', [
  z.strictObject({
    ...envelope,
    type: z.literal('snapshot'),
    model: modelSnapshotSchema.nullable(),
    failure: failureSchema.nullable(),
    typecheck: typecheckSchema.optional(),
    runtime: runtimeStatusSchema.nullable(),
  }),
  z.strictObject({
    ...envelope,
    type: z.literal('model'),
    model: modelSnapshotSchema,
    fromGeneration: z.number().int().positive().nullable(),
    diff: manifestDiffSchema,
    durationMs: z.number().nonnegative(),
  }),
  z.strictObject({
    ...envelope,
    type: z.literal('diagnostics'),
    attempt: z.number().int().positive(),
    diagnostics: z.array(diagnosticSchema).readonly(),
  }),
  z.strictObject({
    ...envelope,
    type: z.literal('runtime'),
    runtime: runtimeStatusSchema,
  }),
  z.strictObject({
    ...envelope,
    type: z.literal('typecheck'),
    revision: z.number().int().nonnegative(),
    diagnostics: z.array(diagnosticSchema).readonly(),
  }),
]);

export type Diagnostic = z.infer<typeof diagnosticSchema>;
export type CompileDiagnostic = z.infer<typeof compileDiagnosticSchema>;
export type ToolDiagnostic = z.infer<typeof toolDiagnosticSchema>;
export type ModelSnapshot = z.infer<typeof modelSnapshotSchema>;
export type RuntimeStatus = z.infer<typeof runtimeStatusSchema>;
export type ManifestDiff = z.infer<typeof manifestDiffSchema>;
export type DevEvent = z.infer<typeof devEventSchema>;
export type SnapshotEvent = Extract<DevEvent, { type: 'snapshot' }>;
export type ModelEvent = Extract<DevEvent, { type: 'model' }>;
export type DiagnosticsEvent = Extract<DevEvent, { type: 'diagnostics' }>;
export type TypecheckEvent = Extract<DevEvent, { type: 'typecheck' }>;
export type RuntimeEvent = Extract<DevEvent, { type: 'runtime' }>;
export type DiagnosticFrame = z.infer<typeof frameSchema>;

/** The compile diagnostic carries a complete `ModelIssue`. */
export type CompileIssue = CompileDiagnostic & ModelIssue;

export type { Manifest, ModelIssue, SourceSite };

/**
 * Activity: what MCP clients (and later `/api` callers) did against the
 * runtime, served by `GET /dev/activity` separately from `/dev/events`. Events
 * are upserts keyed by their ID: a `running` event is replaced by its final
 * version. Record values never appear; requests and results are previews.
 */
export const activityStatusSchema = z.enum(['running', 'succeeded', 'failed']);

export const activityOperationSchema = z.enum([
  'get',
  'query',
  'traverse',
  'invoke',
  'getReceipt',
]);

/**
 * Who made a graph operation. `executionId` is present only when agent
 * JavaScript made the call; a transport request (a future `/api`) has none.
 * `runtimeId` names a `relate dev` runtime host; other hosts have none.
 *
 * Shaped like the planned runtime activity stream's `OperationContext` in
 * `@relate/protocol` (see SPEC "Activity observation"), so moving there is a
 * rename rather than a migration.
 */
export const operationContextSchema = z.strictObject({
  requestId: text,
  runtimeId: text.optional(),
  definitionRevision: text,
  principal: text,
  transport: z.enum(['embedded', 'http', 'mcp']),
  executionId: text.optional(),
});

const errorSummarySchema = z.strictObject({
  code: text,
  message: z.string().optional(),
  /** Request issues as a bounded JSON preview. */
  issues: z.string().optional(),
});

export const activityEventSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('call'),
    requestId: text,
    /** Null when no runtime was running to bind the call to. */
    runtimeId: text.nullable(),
    source: z.enum(['inspector-agent', 'external']),
    /** Null when no model declared a principal to resolve. */
    principal: text.nullable(),
    tool: z.enum(['discover', 'execute']),
    at: text,
    status: activityStatusSchema,
    ms: z.number().nonnegative().optional(),
    /** Why the call could not reach a runtime, or the tool error code. */
    error: z.string().optional(),
  }),
  z.strictObject({
    kind: z.literal('execution'),
    executionId: text,
    requestId: text,
    runtimeId: text,
    principal: text,
    at: text,
    code: z.string(),
    codeTruncated: z.boolean(),
    status: activityStatusSchema,
    logs: z
      .array(
        z.strictObject({
          stream: z.enum(['stdout', 'stderr']),
          text: z.string(),
        }),
      )
      .readonly(),
    logsTruncated: z.boolean(),
    error: z
      .strictObject({
        name: z.string(),
        message: z.string(),
        code: z.string().optional(),
      })
      .optional(),
    resultPreview: z.string().optional(),
    ms: z.number().nonnegative().optional(),
  }),
  z.strictObject({
    kind: z.literal('operation'),
    opId: text,
    context: operationContextSchema,
    at: text,
    op: activityOperationSchema,
    /** Object definition ID, or the action's for `invoke` and `getReceipt`. */
    definitionId: z.string(),
    request: z.strictObject({
      objectId: z.string().optional(),
      traversal: z.string().optional(),
      select: z.array(z.string()).readonly().optional(),
      /** Bounded JSON previews. */
      where: z.string().optional(),
      input: z.string().optional(),
      limit: z.number().optional(),
      cursor: z.string().optional(),
      idempotencyKey: z.string().optional(),
      invocationId: z.string().optional(),
    }),
    status: activityStatusSchema,
    outcome: z
      .strictObject({
        found: z.boolean().optional(),
        records: z.number().int().nonnegative().optional(),
        hasMore: z.boolean().optional(),
        receiptState: z.string().optional(),
        invocationId: z.string().optional(),
        error: errorSummarySchema.optional(),
        evidenceWarnings: z.number().int().nonnegative().optional(),
      })
      .optional(),
    /** IDs of the records returned, bounded. */
    recordIds: z.array(z.string()).readonly(),
    ms: z.number().nonnegative().optional(),
  }),
]);

export const activityMessageSchema = z.discriminatedUnion('type', [
  z.strictObject({
    type: z.literal('snapshot'),
    events: z.array(activityEventSchema).readonly(),
  }),
  z.strictObject({ type: z.literal('event'), event: activityEventSchema }),
]);

export type ActivityStatus = z.infer<typeof activityStatusSchema>;
export type OperationContext = z.infer<typeof operationContextSchema>;
export type ActivityEvent = z.infer<typeof activityEventSchema>;
export type CallEvent = Extract<ActivityEvent, { kind: 'call' }>;
export type ExecutionEvent = Extract<ActivityEvent, { kind: 'execution' }>;
export type OperationEvent = Extract<ActivityEvent, { kind: 'operation' }>;
export type ActivityMessage = z.infer<typeof activityMessageSchema>;

/** The key an activity event is upserted under. */
export function activityKey(event: ActivityEvent): string {
  switch (event.kind) {
    case 'call':
      return `call:${event.requestId}`;
    case 'execution':
      return `execution:${event.executionId}`;
    case 'operation':
      return `operation:${event.opId}`;
  }
}

/** The transport request an event belongs to; eviction is per request. */
export function activityRequestId(event: ActivityEvent): string {
  return event.kind === 'operation' ? event.context.requestId : event.requestId;
}

/** Bootstrap exchange: the terminal token becomes an opaque session cookie. */
export const sessionRequestSchema = z.strictObject({ token: text });

export const instanceIdentitySchema = z.strictObject({
  instanceId: text,
  protocolVersion: z.number().int().positive(),
  ownerId: text,
});

export type InstanceIdentity = z.infer<typeof instanceIdentitySchema>;

export class ProtocolError extends Error {
  readonly reason: 'unsupported-version' | 'invalid';
  readonly protocolVersion: number | undefined;

  constructor(
    reason: ProtocolError['reason'],
    message: string,
    protocolVersion?: number,
  ) {
    super(message);
    this.name = 'ProtocolError';
    this.reason = reason;
    this.protocolVersion = protocolVersion;
  }
}

/** Read only the small version envelope before decoding a model payload. */
export function readProtocolVersion(input: unknown): number | undefined {
  if (!input || typeof input !== 'object') return undefined;

  const version = (input as { protocolVersion?: unknown }).protocolVersion;

  return typeof version === 'number' ? version : undefined;
}

export function parseDevEvent(input: unknown): DevEvent {
  const version = readProtocolVersion(input);

  if (version !== PROTOCOL_VERSION)
    throw new ProtocolError(
      'unsupported-version',
      `Unsupported protocol version ${String(version)}; this inspector speaks ${PROTOCOL_VERSION}`,
      version,
    );

  const result = devEventSchema.safeParse(input);

  if (!result.success)
    throw new ProtocolError(
      'invalid',
      `Invalid development event: ${result.error.issues
        .map(
          (issue) =>
            `${issue.path.map(String).join('.') || '<root>'}: ${issue.message}`,
        )
        .join('; ')}`,
      version,
    );

  return result.data;
}

/** Every diagnostic in a failure stops publishing; type warnings never do. */
export function assertFailureSeverity(
  diagnostics: readonly Diagnostic[],
): void {
  const warning = diagnostics.find((d) => d.severity !== 'error');

  if (warning)
    throw new ProtocolError(
      'invalid',
      `Failure diagnostics must be errors; ${warning.kind} ${warning.code} is ${warning.severity}`,
    );
}

/** Loader, layout and runtime failures are not mistakes in the authored definitions. */
export function diagnosticOrigin(
  diagnostic: Pick<Diagnostic, 'kind'>,
): 'code' | 'loader' | 'layout' | 'runtime' {
  switch (diagnostic.kind) {
    case 'worker':
      return 'loader';
    case 'runtime':
      return 'runtime';
    case 'layout':
      return 'layout';
    default:
      return 'code';
  }
}
