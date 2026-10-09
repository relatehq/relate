import { randomUUID } from 'node:crypto';
import { accepts, canonicalJson } from 'relate/model';
import type { Manifest } from 'relate/model';
import {
  ActionError,
  ReadError,
  presentRead,
  presentPage,
} from '@relate/protocol';
import type {
  FullReadResult,
  FullPageResult,
  Json,
  QueryRequest,
  PageResult,
  ReadRequest,
  ReadResult,
  ActionReceipt,
  FailedReceipt,
} from '@relate/protocol';
import {
  NativeCommitUncertain,
  NativeConflict,
  StorageUnavailable,
} from '../storage.js';
import type {
  NativeRecord,
  NativeInvocation,
  NativeReceiptRead,
  NativeScope,
  NativeTransaction,
  ObservationStore,
} from '../storage.js';
import type { Principal } from '../authorization/index.js';
import { createActionDeadline } from './deadline.js';

type Action = NonNullable<Manifest['actions']>[number];

type ObjectType = Manifest['objects'][number];

export interface ActionExecutionContext {
  readonly actor: Principal;
  readonly input: Record<string, Json>;
  read(type: string, id: string, request?: ReadRequest): Promise<ReadResult>;
  query(type: string, request?: QueryRequest): Promise<PageResult>;
  fail(code: string, details: unknown): never;
  create(type: string, values: unknown): Promise<{ id: string }>;
}

export type ActionHandler = (
  context: ActionExecutionContext,
) => Promise<unknown>;

function parse(shape: Action['input'], value: unknown): Record<string, Json> {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  )
    throw new ActionError('invalid');

  const result: Record<string, Json> = {};

  for (const [name, field] of Object.entries(shape)) {
    const item: unknown = Object.hasOwn(value, name)
      ? (value as Record<string, unknown>)[name]
      : undefined;

    if (
      !accepts(field, item) ||
      (field.references && (typeof item !== 'string' || !item.trim()))
    )
      throw new ActionError('invalid');

    if (item !== undefined) result[name] = item as Json;
  }

  return result;
}

/** Success commits effects; domain failure rolls them back. Both receipts retain the key claim atomically. */
export function createActionExecutor(options: {
  manifest: Manifest;
  scope: NativeScope;
  store: ObservationStore;
  clock(): number;
  timeoutMs: number;
  install(): Promise<void>;
  handlers: Readonly<Record<string, ActionHandler>>;
  read(
    principal: Principal,
    type: string,
    id: string,
    request: ReadRequest,
    transaction: NativeTransaction,
    captureAuthorization?: (check: () => Promise<boolean>) => void,
  ): Promise<FullReadResult>;
  query(
    principal: Principal,
    type: string,
    request: QueryRequest,
    transaction: NativeTransaction,
    onRead: (
      id: string,
      result: Extract<FullReadResult, { status: 'ok' }>,
    ) => void,
  ): Promise<FullPageResult>;
  validate(
    principal: Principal,
    type: ObjectType,
    record: NativeRecord,
    transaction: NativeTransaction,
  ): Promise<void>;
}) {
  const { manifest, store } = options;

  function authorizedAction(actor: Principal, actionId: string) {
    const action = manifest.actions?.find((a) => a.id === actionId);

    if (
      !action?.execute ||
      !actor.roles.includes(action.execute.role) ||
      !actor.id.trim()
    )
      throw new ActionError('denied');

    return action;
  }

  async function authorizeReceipt(
    actor: Principal,
    action: Action,
    saved: NativeInvocation | undefined,
    transaction: NativeTransaction,
  ): Promise<ActionReceipt> {
    if (
      !saved ||
      saved.actorId !== actor.id ||
      !saved.reads ||
      saved.actionDefinitionId !== action.id
    )
      throw new ActionError('denied');

    const input = parse(action.input, saved.input);
    const resultShape =
      saved.receipt.state === 'succeeded'
        ? action.output
        : Object.hasOwn(action.errors ?? {}, saved.receipt.error.code)
          ? action.errors![saved.receipt.error.code]
          : undefined;

    if (!resultShape) throw new ActionError('denied');

    const output = parse(
      resultShape,
      saved.receipt.state === 'succeeded'
        ? saved.receipt.output
        : saved.receipt.error.details,
    );
    const reads = [...saved.reads];
    const authorization: (() => Promise<boolean>)[] = [];

    for (const [shape, values] of [
      [action.input, input],
      [resultShape, output],
    ] as const)
      for (const [name, field] of Object.entries(shape))
        if (field.references)
          reads.push({
            objectDefinitionId: field.references,
            objectId: values[name] as string,
            propertyIds: [],
          });

    for (const read of reads) {
      const object = manifest.objects.find(
        (o) => o.id === read.objectDefinitionId,
      );
      const select = read.propertyIds.map(
        (id) => object?.properties.find((p) => p.id === id)?.name,
      );

      if (!object || select.some((name) => name === undefined))
        throw new ActionError('denied');

      const result = await options.read(
        actor,
        object.id,
        read.objectId,
        { select: select as string[] },
        transaction,
        (check) => authorization.push(check),
      );

      if (
        result.status !== 'ok' ||
        select.some(
          (name) =>
            !['available', 'absent'].includes(
              result.meta.fields[name!]?.status ?? '',
            ),
        )
      )
        throw new ActionError('denied');
    }

    // Later dependency reads may outlast an earlier permission's evidence bound.
    for (const allowed of authorization)
      if (!(await allowed())) throw new ActionError('denied');

    return structuredClone(saved.receipt);
  }

  function rejection(error: unknown): never {
    if (error instanceof NativeConflict) throw new ActionError('conflict');

    if (error instanceof NativeCommitUncertain)
      throw new ActionError('uncertain');

    if (error instanceof ActionError) throw error;

    if (
      error instanceof StorageUnavailable ||
      (error instanceof ReadError && error.code === 'unavailable')
    )
      throw new ActionError('unavailable');

    throw new ActionError('internal');
  }

  const invoke = async (
    principal: Principal,
    actionId: string,
    request: { input: unknown; idempotencyKey: string },
  ): Promise<ActionReceipt> => {
    const actor = structuredClone(principal);
    const action = authorizedAction(actor, actionId);

    if (
      !request ||
      typeof request.idempotencyKey !== 'string' ||
      !request.idempotencyKey.trim()
    )
      throw new ActionError('invalid');

    const input = parse(action.input, request.input);
    const key = request.idempotencyKey;
    const handler = options.handlers[action.id];

    if (!handler || !store.native) throw new ActionError('unsupported');

    let deadline: ReturnType<typeof createActionDeadline> | undefined;

    try {
      await options.install();

      return await store.native.transaction(
        options.scope,
        async (transaction) => {
          deadline = createActionDeadline(transaction, options.timeoutMs);

          return deadline.run(async (transaction, check) => {
            const existing = await transaction.claim(action.id, key);

            if (existing) {
              // Check ownership before input equality to avoid exposing another actor's invocation.
              if (existing.actorId !== actor.id)
                throw new ActionError('denied');

              const receipt = await authorizeReceipt(
                actor,
                action,
                existing,
                transaction,
              );

              if (canonicalJson(existing.input) !== canonicalJson(input))
                throw new ActionError('conflict');

              return receipt;
            }

            const reads: NativeReceiptRead[] = [];
            const definitions = new Map(manifest.objects.map((o) => [o.id, o]));
            const recordRead = (
              type: string,
              id: string,
              result: Extract<FullReadResult, { status: 'ok' }>,
            ) => {
              const object = definitions.get(type)!;

              reads.push({
                objectDefinitionId: type,
                objectId: id,
                propertyIds: object.properties
                  .filter((p) =>
                    ['available', 'absent'].includes(
                      result.meta.fields[p.name]?.status ?? '',
                    ),
                  )
                  .map((p) => p.id),
              });
            };
            const created: NativeRecord[] = [];
            let accepting = true;
            let failure: unknown;
            let aborted = false;
            const domainSignal = new Error('Declared action failure');
            let domain: FailedReceipt['error'] | undefined;
            const pending: Promise<unknown>[] = [];
            const run = <T>(operation: () => Promise<T>): Promise<T> => {
              if (domain || !accepting) {
                const rejected = Promise.reject(
                  domain ? domainSignal : new ActionError('invalid'),
                );

                // A caught fail() can leave fire-and-forget work behind. Revoke it
                // without turning its ignored rejection into a process-level error.
                void rejected.catch(() => {});

                return rejected;
              }

              const promise = Promise.resolve()
                .then(async () => {
                  check();

                  if (aborted) throw failure;

                  if (domain) throw domainSignal;

                  const result = await operation();

                  check();

                  return result;
                })
                .catch((error: unknown) => {
                  if (error === domainSignal) throw error;

                  if (!aborted) failure = error;

                  aborted = true;
                  throw error;
                });

              pending.push(promise);
              // Prevent unhandled rejection when implementation neglects to await; finalization still fails.
              void promise.catch(() => {});

              return promise;
            };
            const checkReferences = async (
              shape: Action['input'],
              values: Record<string, Json>,
            ) => {
              for (const [name, field] of Object.entries(shape))
                if (field.references) {
                  check();
                  const result = await options.read(
                    actor,
                    field.references,
                    values[name] as string,
                    { select: [] },
                    transaction,
                  );

                  if (result.status !== 'ok')
                    throw new ActionError('not-found');
                }
            };

            await checkReferences(action.input, input);
            let output: Record<string, Json> = {};

            const executeHandler = async () => {
              try {
                const result = await handler({
                  actor: structuredClone(actor),
                  input: structuredClone(input),
                  fail: (code, details): never => {
                    check();

                    if (aborted) throw failure;

                    if (domain) throw domainSignal;

                    if (!accepting) throw new ActionError('invalid');

                    try {
                      if (
                        typeof code !== 'string' ||
                        !Object.hasOwn(action.errors ?? {}, code)
                      )
                        throw new Error('Undeclared failure');

                      domain = {
                        kind: 'domain',
                        code,
                        details: parse(action.errors![code]!, details),
                      };
                    } catch {
                      // A handler bug is not a declared business outcome, even when caught.
                      aborted = true;
                      failure = new ActionError('internal');
                      throw failure;
                    }

                    throw domainSignal;
                  },
                  query: (type, request = {}) =>
                    run(async () =>
                      presentPage(
                        await options.query(
                          actor,
                          type,
                          request,
                          transaction,
                          (id, result) => recordRead(type, id, result),
                        ),
                        request.evidence,
                      ),
                    ),
                  read: (type, id, request = {}) =>
                    run(async () => {
                      const result = await options.read(
                        actor,
                        type,
                        id,
                        request,
                        transaction,
                      );

                      if (result.status === 'ok') recordRead(type, id, result);

                      return presentRead(result, request.evidence);
                    }),
                  create: (type, values) =>
                    run(async () => {
                      const object = manifest.objects.find(
                        (o) => o.id === type,
                      );

                      if (
                        !object ||
                        object.sourceDefinitionId ||
                        !action.creates.includes(type)
                      )
                        throw new ActionError('denied');

                      const properties = object.properties.filter(
                        (p) => p.origin.kind !== 'object-id',
                      );

                      if (
                        !values ||
                        typeof values !== 'object' ||
                        Array.isArray(values) ||
                        Object.keys(values).some(
                          (name) => !properties.some((p) => p.name === name),
                        )
                      )
                        throw new ActionError('invalid');

                      const shape = Object.fromEntries(
                        properties.map((p) => [
                          p.name,
                          {
                            ...p.schema,
                            ...(p.origin.kind === 'native-reference'
                              ? {
                                  references: p.origin.targetObjectDefinitionId,
                                }
                              : {}),
                          },
                        ]),
                      );
                      const parsed = parse(shape, values);
                      const record: NativeRecord = {
                        objectDefinitionId: object.id,
                        objectId: randomUUID(),
                        createdAt: options.clock(),
                        values: Object.fromEntries(
                          properties
                            .filter((p) => Object.hasOwn(parsed, p.name))
                            .map((p) => [p.id, parsed[p.name]!]),
                        ),
                      };

                      await options.validate(
                        actor,
                        object,
                        record,
                        transaction,
                      );
                      await transaction.insert(record);
                      created.push(record);

                      return { id: record.objectId };
                    }),
                });

                if (!domain) output = parse(action.output, result);
              } catch (error) {
                if (!domain) throw error;
              } finally {
                accepting = false;
                await Promise.allSettled(pending);
              }

              if (aborted) throw failure;

              if (domain) throw domainSignal;
            };

            try {
              // Success-only actions need no recoverable business-failure boundary.
              if (Object.keys(action.errors ?? {}).length)
                await transaction.savepoint(executeHandler);
              else await executeHandler();
            } catch (error) {
              if (error !== domainSignal) throw error;
            }

            // Recheck after arbitrary implementation awaits and all native writes.
            await checkReferences(action.input, input);

            for (const record of domain ? [] : created)
              await options.validate(
                actor,
                manifest.objects.find(
                  (o) => o.id === record.objectDefinitionId,
                )!,
                record,
                transaction,
              );

            if (domain)
              await checkReferences(
                action.errors![domain.code]!,
                domain.details as Record<string, Json>,
              );
            else await checkReferences(action.output, output);

            const receipt: ActionReceipt = domain
              ? {
                  invocationId: randomUUID(),
                  state: 'failed',
                  error: domain,
                }
              : {
                  invocationId: randomUUID(),
                  state: 'succeeded',
                  output,
                };

            // Reads of rolled-back objects are not durable dependencies. Their source/input
            // dependencies remain; reference-valued details must still resolve after rollback.
            const retainedReads = domain
              ? reads.filter(
                  (read) =>
                    !created.some(
                      (record) =>
                        record.objectDefinitionId === read.objectDefinitionId &&
                        record.objectId === read.objectId,
                    ),
                )
              : reads;
            const invocation: NativeInvocation = {
              actionDefinitionId: action.id,
              idempotencyKey: key,
              actorId: actor.id,
              reads: retainedReads,
              input,
              receipt,
            };

            // Rollback changes the authorization view. Recheck recorded fields too,
            // since scalar failure details may have been derived from those reads.
            if (domain)
              await authorizeReceipt(actor, action, invocation, transaction);

            await transaction.saveInvocation(invocation);

            return receipt;
          });
        },
      );
    } catch (error) {
      return rejection(error);
    } finally {
      // An adapter can fail while the callback is suspended (for example a dead PG session).
      deadline?.close();
    }
  };

  return {
    invoke,
    async getReceipt(
      principal: Principal,
      actionId: string,
      invocationId: string,
    ): Promise<ActionReceipt> {
      const actor = structuredClone(principal);
      const action = authorizedAction(actor, actionId);

      if (typeof invocationId !== 'string' || !invocationId.trim())
        throw new ActionError('denied');

      if (!store.native) throw new ActionError('unsupported');

      let deadline: ReturnType<typeof createActionDeadline> | undefined;

      try {
        await options.install();

        return await store.native.transaction(
          options.scope,
          async (transaction) => {
            deadline = createActionDeadline(transaction, options.timeoutMs);

            return deadline.run(async (transaction) =>
              authorizeReceipt(
                actor,
                action,
                await transaction.findInvocation(action.id, invocationId),
                transaction,
              ),
            );
          },
        );
      } catch (error) {
        // Lookup has no business effects, so losing its transaction acknowledgement is an outage.
        if (error instanceof NativeCommitUncertain)
          throw new ActionError('unavailable');

        return rejection(error);
      } finally {
        deadline?.close();
      }
    },
  };
}
