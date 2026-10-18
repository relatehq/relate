import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import type { OperationActor, OperationContext } from '@relate/protocol';
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

/** Mutable facts the engine learns while an operation runs. */
export interface ActiveOperation {
  readonly scope: OperationScope;
  invocation?: { readonly id: string; readonly replayed: boolean };
}

const active = new AsyncLocalStorage<ActiveOperation>();

/** The runtime's own work outside any consumer or host call. */
export const runtimeActor: OperationActor = Object.freeze({
  kind: 'system',
  id: 'relate.runtime',
});

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

export function runInOperation<T>(
  operation: ActiveOperation,
  run: () => Promise<T>,
): Promise<T> {
  return active.run(operation, run);
}

export function activeOperation(): ActiveOperation | undefined {
  return active.getStore();
}

/** Record which invocation the current invoke attempt executed or replayed. */
export function noteInvocation(id: string, replayed: boolean): void {
  const operation = activeOperation();

  if (operation) operation.invocation = { id, replayed };
}
