import { randomUUID } from 'node:crypto';
import { accepts, canonicalJson } from 'relate/model';
import type { Manifest } from 'relate/model';
import { ActionError, ReadError } from '@relate/protocol';
import type {
  Json,
  ReadRequest,
  ReadResult,
  SucceededReceipt,
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

/** Native business effects and the successful receipt share exactly one transaction. */
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
  ): Promise<ReadResult>;
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
  ): Promise<SucceededReceipt> {
    if (
      !saved ||
      saved.actorId !== actor.id ||
      !saved.reads ||
      saved.actionDefinitionId !== action.id
    )
      throw new ActionError('denied');

    const input = parse(action.input, saved.input);
    const output = parse(action.output, saved.receipt.output);
    const reads = [...saved.reads];
    const authorization: (() => Promise<boolean>)[] = [];

    for (const [shape, values] of [
      [action.input, input],
      [action.output, output],
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
  ): Promise<SucceededReceipt> => {
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
            const created: NativeRecord[] = [];
            let accepting = true;
            let failure: unknown;
            let aborted = false;
            const pending: Promise<unknown>[] = [];
            const run = <T>(operation: () => Promise<T>): Promise<T> => {
              if (!accepting) return Promise.reject(new ActionError('invalid'));

              const promise = Promise.resolve()
                .then(async () => {
                  check();

                  if (aborted) throw failure;

                  const result = await operation();

                  check();

                  return result;
                })
                .catch((error: unknown) => {
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

                  if (result.status !== 'ok') throw new ActionError('denied');
                }
            };

            await checkReferences(action.input, input);
            let output: Record<string, Json>;

            try {
              const result = await handler({
                actor: structuredClone(actor),
                input: structuredClone(input),
                read: (type, id, request = {}) =>
                  run(async () => {
                    const result = await options.read(
                      actor,
                      type,
                      id,
                      request,
                      transaction,
                    );

                    if (result.status === 'ok') {
                      const object = manifest.objects.find(
                        (o) => o.id === type,
                      )!;

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
                    }

                    return result;
                  }),
                create: (type, values) =>
                  run(async () => {
                    const object = manifest.objects.find((o) => o.id === type);

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
                            ? { references: p.origin.targetObjectDefinitionId }
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

                    await options.validate(actor, object, record, transaction);
                    await transaction.insert(record);
                    created.push(record);

                    return { id: record.objectId };
                  }),
              });

              output = parse(action.output, result);
            } finally {
              accepting = false;
              await Promise.allSettled(pending);
            }

            if (aborted) throw failure;

            // Recheck after arbitrary implementation awaits and all native writes.
            await checkReferences(action.input, input);

            for (const record of created)
              await options.validate(
                actor,
                manifest.objects.find(
                  (o) => o.id === record.objectDefinitionId,
                )!,
                record,
                transaction,
              );

            await checkReferences(action.output, output);
            const receipt: SucceededReceipt = {
              invocationId: randomUUID(),
              state: 'succeeded',
              output,
            };

            await transaction.saveInvocation({
              actionDefinitionId: action.id,
              idempotencyKey: key,
              actorId: actor.id,
              reads,
              input,
              receipt,
            });

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
    ): Promise<SucceededReceipt> {
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
