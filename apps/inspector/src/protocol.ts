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

/** 3: runtime activity records on operation events. */
export const PROTOCOL_VERSION = 3 as const;

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
  // Recorded by the runtime only: nested source refreshes and host adoption.
  'refresh',
  'adopt',
  // Committed feed entries: business changes and finished invocations.
  'created',
  'adopted',
  'updated',
  'deleted',
  'restored',
  'invocation-succeeded',
  'invocation-failed',
]);

const activityActorSchema = z.strictObject({
  kind: z.enum(['principal', 'system', 'source']),
  id: text,
});

/**
 * What the runtime recorded for an operation event, forwarded by the runtime
 * host. An `attempt` is a best-effort operation row; `committed` is a durable
 * feed entry, committed with the state it describes. Metadata only: IDs,
 * actors and outcomes, never values.
 */
const stageTimingSchema = z
  .strictObject({
    count: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    totalMs: z.number().nonnegative(),
    maxMs: z.number().nonnegative(),
  })
  .refine((value) => value.maxMs <= value.totalMs);

export const analyticalTimingsSchema = z.strictObject({
  stages: z.strictObject({
    preparation: stageTimingSchema.optional(),
    candidates: stageTimingSchema.optional(),
    dependencyReads: stageTimingSchema.optional(),
    planning: stageTimingSchema.optional(),
    queueWait: stageTimingSchema.optional(),
    connectionStartup: stageTimingSchema.optional(),
    execution: stageTimingSchema.optional(),
    revalidation: stageTimingSchema.optional(),
    finalization: stageTimingSchema.optional(),
  }),
});

export const runtimeRecordSchema = z.strictObject({
  record: z.enum(['attempt', 'committed']),
  analytical: analyticalTimingsSchema.optional(),
  actor: activityActorSchema,
  /** A source change: the actor whose operation triggered the refresh. */
  triggeredBy: activityActorSchema.optional(),
  /** The enclosing operation, e.g. the read that triggered a refresh. */
  parentOperationId: text.optional(),
  /** Attempts: the runtime outcome status and its sanitized code. */
  outcome: z
    .enum(['ok', 'not-found', 'succeeded', 'failed', 'rejected', 'uncertain'])
    .optional(),
  code: text.optional(),
  replayed: z.boolean().optional(),
  refresh: z.enum(['changed', 'unchanged', 'superseded']).optional(),
  /** Stable property IDs the actor was refused, across the lineage. */
  forbidden: z.array(text).readonly().optional(),
  omittedObjects: z.number().int().nonnegative().optional(),
  /** Committed entries: feed position and changed property IDs. */
  position: text.optional(),
  changedPropertyIds: z.array(text).readonly().optional(),
});

/**
 * Who made a graph operation. `executionId` is present only when agent
 * JavaScript made the call; a transport request (a future `/api`) has none.
 * `runtimeId` names a `relate dev` runtime host; other hosts have none.
 *
 * Shaped like the planned runtime activity stream's `OperationContext` in
 * `@relate/protocol` (see specs/2026-10-13-activity.md), so moving there is a
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
    /** Present once the runtime's own record of this operation arrives. */
    runtime: runtimeRecordSchema.optional(),
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
export type RuntimeRecord = z.infer<typeof runtimeRecordSchema>;
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

/**
 * The built-in agent, served under `/dev/agent/*`. The loop runs in the dev
 * server (the API key never reaches the browser) and keeps one conversation
 * per development principal. These are display shapes: the model's own
 * history, thinking included, stays in the dev server.
 *
 *   GET  /dev/agent/conversations            → AgentSnapshot
 *   GET  /dev/agent/events (SSE)             → AgentSnapshot, then AgentEvent…
 *   POST /dev/agent/turns  AgentTurnRequest  → 202 AgentTurnAccepted
 *   POST /dev/agent/turns/:turnId/cancel     → 202 AgentTurnAccepted
 *   POST /dev/agent/conversations/:principal/reset → 202 AgentResetAccepted
 */
export const AGENT_TEXT_LIMIT = 32 * 1024;

export const agentAvailabilitySchema = z.discriminatedUnion('available', [
  z.strictObject({ available: z.literal(true), model: text }),
  z.strictObject({
    available: z.literal(false),
    /** `missing-key`: `ANTHROPIC_API_KEY` is not in the dev server's environment. */
    reason: z.enum(['missing-key']),
  }),
]);

export const agentMessageSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('user'),
    id: text,
    at: text,
    text: z.string(),
  }),
  /** One text block of a model response; grows by `text` events while streaming. */
  z.strictObject({ kind: z.literal('assistant'), id: text, text: z.string() }),
  /** A summary of the model's reasoning; grows by `text` events while streaming. */
  z.strictObject({ kind: z.literal('thinking'), id: text, text: z.string() }),
  z.strictObject({
    kind: z.literal('tool'),
    /** The model's `tool_use` ID. */
    id: text,
    name: z.string(),
    /** `execute`: the code; otherwise the input as bounded JSON. */
    input: z.string(),
    /** The activity request this call is recorded under (`CallEvent.requestId`). */
    requestId: text,
    status: z.enum(['running', 'succeeded', 'failed', 'cancelled']),
    /** Bounded preview of what the tool returned to the model. */
    result: z.string().optional(),
  }),
  /** Refusals, truncation, cancellation and API errors, said plainly. */
  z.strictObject({
    kind: z.literal('notice'),
    id: text,
    level: z.enum(['info', 'warning', 'error']),
    text: z.string(),
  }),
]);

export const agentTurnSchema = z.strictObject({
  turnId: text,
  /** The principal the turn started with; a selector change never alters it. */
  principal: text,
  status: z.enum(['running', 'cancelling']),
});

export const agentConversationSchema = z.strictObject({
  principal: text,
  turn: agentTurnSchema.nullable(),
  messages: z.array(agentMessageSchema).readonly(),
});

export const agentSnapshotSchema = z.strictObject({
  type: z.literal('snapshot'),
  availability: agentAvailabilitySchema,
  conversations: z.array(agentConversationSchema).readonly(),
});

export const agentEventSchema = z.discriminatedUnion('type', [
  agentSnapshotSchema,
  /** A turn started, is cancelling, or ended (`turn: null`). */
  z.strictObject({
    type: z.literal('turn'),
    principal: text,
    turn: agentTurnSchema.nullable(),
  }),
  /** Insert or replace a message by ID. */
  z.strictObject({
    type: z.literal('message'),
    principal: text,
    message: agentMessageSchema,
  }),
  /** Append streamed text to an assistant or thinking message. */
  z.strictObject({
    type: z.literal('text'),
    principal: text,
    messageId: text,
    delta: z.string(),
  }),
  /** The principal's conversation was cleared; the model starts afresh. */
  z.strictObject({ type: z.literal('reset'), principal: text }),
]);

export const agentTurnRequestSchema = z.strictObject({
  principal: text,
  text: z.string().trim().min(1).max(AGENT_TEXT_LIMIT),
});

export const agentTurnAcceptedSchema = z.strictObject({
  turnId: text,
  principal: text,
});

export const agentResetAcceptedSchema = z.strictObject({ principal: text });

export const agentErrorSchema = z.strictObject({ error: z.string() });

export type AgentAvailability = z.infer<typeof agentAvailabilitySchema>;
export type AgentMessage = z.infer<typeof agentMessageSchema>;
export type AgentToolMessage = Extract<AgentMessage, { kind: 'tool' }>;
export type AgentTurn = z.infer<typeof agentTurnSchema>;
export type AgentConversation = z.infer<typeof agentConversationSchema>;
export type AgentSnapshot = z.infer<typeof agentSnapshotSchema>;
export type AgentEvent = z.infer<typeof agentEventSchema>;
export type AgentTurnRequest = z.infer<typeof agentTurnRequestSchema>;
export type AgentTurnAccepted = z.infer<typeof agentTurnAcceptedSchema>;
export type AgentResetAccepted = z.infer<typeof agentResetAcceptedSchema>;

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
