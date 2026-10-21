import type { Manifest } from 'relate/model';
import { ActionError, ReadError } from '@relate/protocol';
import type {
  ActivityObjectRef,
  FieldEvidence,
  FullObjectRecord,
  Operation,
  OperationObject,
  RejectedOutcome,
} from '@relate/protocol';
import type { OperationDraft } from '../storage.js';
import type { OperationRecorder } from './recorder.js';
import type { OperationScope } from './scope.js';
import { beginOperationDiagnostics } from './scope.js';

type ObjectType = Manifest['objects'][number];

type Distribute<T> = T extends unknown
  ? Omit<
      T,
      | 'schemaVersion'
      | 'id'
      | 'parentOperationId'
      | 'graphId'
      | 'definitionRevision'
      | 'actor'
      | 'context'
      | 'startedAt'
      | 'completedAt'
      | 'durationMs'
      | 'recordedAt'
    >
  : never;

/** The variant-specific part of an operation, derived from its typed result. */
export type OperationBody = Distribute<Operation>;

export type Settled<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: unknown };

/** Stable property IDs per evidence status, in selection order. Never values. */
export function fieldLineage(
  object: ObjectType | undefined,
  fields: Readonly<Record<string, FieldEvidence>>,
): Pick<OperationObject, 'returned' | 'forbidden' | 'unavailable'> {
  const returned: string[] = [],
    forbidden: string[] = [],
    unavailable: string[] = [];

  for (const [name, field] of Object.entries(fields)) {
    // Caller aliases and unknown names have no stable identity to record.
    const id =
      object?.properties.find((p) => p.name === name)?.id ??
      object?.calculations?.find((p) => p.name === name)?.id;

    if (!id) continue;

    if (field.status === 'forbidden') forbidden.push(id);
    else if (field.status === 'unavailable') unavailable.push(id);
    else returned.push(id);
  }

  return { returned, forbidden, unavailable };
}

export function lineageEntry(
  manifest: Manifest,
  objectDefinitionId: string,
  role: OperationObject['role'],
  record: Pick<FullObjectRecord, 'id' | 'meta'>,
): OperationObject {
  return {
    objectDefinitionId,
    objectId: record.id,
    role,
    ...fieldLineage(
      manifest.objects.find((o) => o.id === objectDefinitionId),
      record.meta.fields,
    ),
  };
}

export function referenceEntry(
  ref: ActivityObjectRef,
  role: OperationObject['role'],
): OperationObject {
  return {
    objectDefinitionId: ref.objectDefinitionId,
    objectId: ref.objectId,
    role,
    returned: [],
    forbidden: [],
    unavailable: [],
  };
}

/** A sanitized rejection; unknown failures never expose their messages. */
export function rejected(error: unknown): RejectedOutcome {
  if (error instanceof ReadError)
    return { status: 'rejected', code: error.code };

  if (error instanceof ActionError && error.code !== 'uncertain')
    return { status: 'rejected', code: error.code };

  return { status: 'rejected', code: 'internal' };
}

/** Builds envelopes and enqueues settled operations; recording never fails a call. */
export function createCapture(options: {
  readonly graphId: string;
  readonly definitionRevision: string;
  readonly recorder: OperationRecorder;
}) {
  const { recorder } = options;

  function record(
    scope: OperationScope,
    started: { at: number; monotonic: number },
    body: OperationBody,
  ) {
    let objects = body.objects;
    let details = body.details;
    const omitted = objects.length - recorder.limits.maxObjects;

    if (omitted > 0) {
      objects = objects.slice(0, recorder.limits.maxObjects);
      details = { ...details, truncated: { omittedObjects: omitted } };
      recorder.truncated(body.kind, omitted);
    }

    recorder.record({
      ...body,
      objects,
      details,
      schemaVersion: 1,
      id: scope.id,
      ...(scope.parent ? { parentOperationId: scope.parent.id } : {}),
      graphId: options.graphId,
      definitionRevision: options.definitionRevision,
      actor: scope.actor,
      context: scope.context,
      startedAt: new Date(started.at).toISOString(),
      completedAt: new Date().toISOString(),
      durationMs: Math.max(0, performance.now() - started.monotonic),
    } as OperationDraft);
  }

  return {
    /**
     * Run one consumer or host operation in its scope and record it once it
     * settles. Execution passes the scope explicitly to any nested work.
     */
    async operation<T>(
      scope: OperationScope,
      run: () => Promise<T>,
      describe: (settled: Settled<T>) => OperationBody | undefined,
    ): Promise<T> {
      const started = { at: Date.now(), monotonic: performance.now() };
      let settled: Settled<T>;
      const diagnostics = recorder.enabled
        ? beginOperationDiagnostics(scope)
        : undefined;

      try {
        settled = { ok: true, value: await run() };
      } catch (error) {
        settled = { ok: false, error };
      }

      if (recorder.enabled)
        try {
          const body = describe(settled);

          if (body) {
            const analytical = diagnostics?.analytical();

            record(scope, started, {
              ...body,
              details: {
                ...body.details,
                ...(analytical ? { analytical } : {}),
              },
            } as OperationBody);
          }
        } catch {
          // A description bug must not change the caller's result.
        }

      diagnostics?.close();

      if (!settled.ok) throw settled.error;

      return settled.value;
    },
    /** Record an operation whose timing the caller tracked, such as a refresh. */
    record(
      scope: OperationScope,
      started: { at: number; monotonic: number },
      body: OperationBody,
    ) {
      if (!recorder.enabled) return;

      try {
        record(scope, started, body);
      } catch {
        // Recording never fails the operation it describes.
      }
    },
  };
}

export type Capture = ReturnType<typeof createCapture>;
