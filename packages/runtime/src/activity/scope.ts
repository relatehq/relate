import { randomUUID } from 'node:crypto';
import type {
  AnalyticalTimings,
  OperationActor,
  OperationContext,
} from '@relate/protocol';
import { isUuidv7, uuidv7 } from './ids.js';

/**
 * One attempt's identity at the trusted dispatch boundary. Never a consumer
 * option or part of a reusable principal binding: each call gets its own ID.
 */
export interface OperationScope {
  readonly id: string;
  readonly actor: OperationActor;
  readonly context: OperationContext;
  readonly parent?: {
    readonly id: string;
    readonly actor: OperationActor;
  };
}

/**
 * Embedded callers get a fresh request ID per operation, not per binding. A
 * trusted transport that assigns operation identity itself (the `relate dev`
 * runtime host) passes a UUIDv7 `id`.
 */
export function createOperationScope(
  actor: OperationActor,
  context: Partial<OperationContext> = {},
  id?: string,
): OperationScope {
  if (id !== undefined && !isUuidv7(id))
    throw new Error('Operation ID must be a UUIDv7');

  return {
    id: id ?? uuidv7(),
    actor: { kind: actor.kind, id: actor.id },
    context: snapshotContext(context),
  };
}

export function snapshotContext(
  context: Partial<OperationContext> = {},
): OperationContext {
  return {
    requestId: context.requestId ?? randomUUID(),
    transport: context.transport ?? 'embedded',
    ...(context.executionId !== undefined
      ? { executionId: context.executionId }
      : {}),
    ...(context.runtimeId !== undefined
      ? { runtimeId: context.runtimeId }
      : {}),
    ...(context.initiator !== undefined
      ? {
          initiator: {
            kind: context.initiator.kind,
            id: context.initiator.id,
          } as OperationContext['initiator'] & object,
        }
      : {}),
  };
}

/** A nested operation: fresh ID, the triggering actor, the enclosing parent. */
export function nestedScope(parent: OperationScope): OperationScope {
  return {
    id: uuidv7(),
    actor: parent.actor,
    context: parent.context,
    parent: { id: parent.id, actor: parent.actor },
  };
}

/** Private, per-attempt diagnostic providers exist only while enabled capture runs. */
interface OperationDiagnostics {
  analytical?: () => AnalyticalTimings;
}

const diagnostics = new WeakMap<OperationScope, OperationDiagnostics>();

export function operationDiagnostics(
  scope: OperationScope,
): OperationDiagnostics | undefined {
  return diagnostics.get(scope);
}

export function beginOperationDiagnostics(scope: OperationScope) {
  const providers: OperationDiagnostics = {};

  diagnostics.set(scope, providers);

  return {
    analytical() {
      try {
        return providers.analytical?.();
      } catch {
        return undefined;
      }
    },
    close() {
      diagnostics.delete(scope);
    },
  };
}
