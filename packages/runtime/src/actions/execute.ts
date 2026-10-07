import { randomUUID } from 'node:crypto';
import { accepts } from 'relate/model';
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
  NativeScope,
  NativeTransaction,
  ObservationStore,
} from '../storage.js';
import type { Principal } from '../authorization/index.js';

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
  install(): Promise<void>;
  handlers: Readonly<Record<string, ActionHandler>>;
  read(
    principal: Principal,
    type: string,
    id: string,
    request: ReadRequest,
    transaction: NativeTransaction,
  ): Promise<ReadResult>;
  validate(
    principal: Principal,
    type: ObjectType,
    record: NativeRecord,
    transaction: NativeTransaction,
  ): Promise<void>;
}) {
  const { manifest, store } = options;

  return async (
    principal: Principal,
    actionId: string,
    request: { input: unknown; idempotencyKey: string },
  ): Promise<SucceededReceipt> => {
    const actor = structuredClone(principal);
    const action = manifest.actions?.find((a) => a.id === actionId);

    if (
      !action?.execute ||
      !actor.roles.includes(action.execute.role) ||
      !actor.id.trim()
    )
      throw new ActionError('denied');

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

    try {
      await options.install();

      return await store.native.transaction(
        options.scope,
        async (transaction) => {
          await transaction.claim(action.id, key);
          const created: NativeRecord[] = [];
          let accepting = true;
          let failure: unknown;
          let aborted = false;
          const pending: Promise<unknown>[] = [];
          const run = <T>(operation: () => Promise<T>): Promise<T> => {
            if (!accepting) return Promise.reject(new ActionError('invalid'));

            const promise = Promise.resolve()
              .then(async () => {
                if (aborted) throw failure;

                return operation();
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
                run(() => options.read(actor, type, id, request, transaction)),
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
              manifest.objects.find((o) => o.id === record.objectDefinitionId)!,
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
            input,
            receipt,
          });

          return receipt;
        },
      );
    } catch (error) {
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
  };
}
