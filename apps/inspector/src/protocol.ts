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

export const PROTOCOL_VERSION = 1 as const;

const text = z.string().min(1);
const identifierList = z.array(text);

export const sourceSiteSchema = z.strictObject({
  file: text,
  line: z.number().int().positive(),
  column: z.number().int().positive(),
  precision: z.enum(['declaration', 'expression']),
});

export const issuePathSchema = z.strictObject({
  root: z.enum(['graph', 'definition', 'manifest']),
  segments: z.array(z.union([z.string(), z.number().int()])),
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
  kind: z.enum(['syntax', 'import', 'worker', 'layout', 'type']),
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
  diagnostics: z.array(diagnosticSchema),
});

const typecheckSchema = z.strictObject({
  revision: z.number().int().nonnegative(),
  diagnostics: z.array(diagnosticSchema),
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
    diagnostics: z.array(diagnosticSchema),
  }),
  z.strictObject({
    ...envelope,
    type: z.literal('typecheck'),
    revision: z.number().int().nonnegative(),
    diagnostics: z.array(diagnosticSchema),
  }),
]);

export type Diagnostic = z.infer<typeof diagnosticSchema>;
export type CompileDiagnostic = z.infer<typeof compileDiagnosticSchema>;
export type ToolDiagnostic = z.infer<typeof toolDiagnosticSchema>;
export type ModelSnapshot = z.infer<typeof modelSnapshotSchema>;
export type ManifestDiff = z.infer<typeof manifestDiffSchema>;
export type DevEvent = z.infer<typeof devEventSchema>;
export type SnapshotEvent = Extract<DevEvent, { type: 'snapshot' }>;
export type ModelEvent = Extract<DevEvent, { type: 'model' }>;
export type DiagnosticsEvent = Extract<DevEvent, { type: 'diagnostics' }>;
export type TypecheckEvent = Extract<DevEvent, { type: 'typecheck' }>;
export type DiagnosticFrame = z.infer<typeof frameSchema>;

/** The compile diagnostic carries a complete `ModelIssue`. */
export type CompileIssue = CompileDiagnostic & ModelIssue;

export type { Manifest, ModelIssue, SourceSite };

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

/** Loader and layout failures are not mistakes in the authored code. */
export function diagnosticOrigin(
  diagnostic: Pick<Diagnostic, 'kind'>,
): 'code' | 'loader' | 'layout' {
  switch (diagnostic.kind) {
    case 'worker':
      return 'loader';
    case 'layout':
      return 'layout';
    default:
      return 'code';
  }
}
