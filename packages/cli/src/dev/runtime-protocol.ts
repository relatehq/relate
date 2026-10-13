/**
 * IPC contract between the dev server and its runtime host. Every graph
 * request names the `runtimeId` its binding was created against; the host and
 * the dev server both reject a retired one with a public `runtime-retired`
 * error and never redirect or replay it.
 *
 * Validated messages in both directions over structured-clone IPC, so values
 * JSON cannot represent (NaN, undefined, Dates) arrive unchanged. Errors cross
 * as public protocol codes only, never stacks or causes.
 */
import { z } from 'zod';
import { ActionError, ReadError } from '@relate/protocol';
import type {
  ActionDescription,
  GraphDescription,
  ObjectDescription,
  ReadErrorDetails,
} from '@relate/protocol';
import { diagnosticSchema } from '@relate/inspector/protocol';

export const runtimeOperations = [
  'get',
  'query',
  'traverse',
  'invoke',
  'getReceipt',
] as const;

export type RuntimeOperation = (typeof runtimeOperations)[number];

const text = z.string().min(1);
const id = z.number().int().nonnegative();

export const runtimeRequestSchema = z.discriminatedUnion('type', [
  z.strictObject({
    type: z.literal('op'),
    id,
    /** The runtime this binding was created against. */
    runtimeId: text,
    principal: text,
    operation: z.enum(runtimeOperations),
    args: z.array(z.unknown()),
  }),
  z.strictObject({
    type: z.literal('discovery'),
    id,
    runtimeId: text,
    principal: text,
  }),
  /** Retire: reject new requests, drain in-flight ones, close and exit. */
  z.strictObject({ type: z.literal('close') }),
]);

export type RuntimeRequest = z.infer<typeof runtimeRequestSchema>;

export const wireErrorSchema = z.strictObject({
  name: z.enum(['ReadError', 'ActionError', 'Error']),
  code: text,
  message: z.string(),
  details: z
    .strictObject({
      operation: z.string(),
      issues: z.array(z.unknown()),
      acceptedOptions: z.array(z.string()).optional(),
    })
    .optional(),
});

export type WireError = z.infer<typeof wireErrorSchema>;

export const runtimeMessageSchema = z.discriminatedUnion('type', [
  z.strictObject({
    type: z.literal('reply'),
    id,
    value: z.unknown(),
  }),
  z.strictObject({
    type: z.literal('error'),
    id,
    error: wireErrorSchema,
  }),
  z.strictObject({
    type: z.literal('ready'),
    runtimeId: text,
    definitionRevision: text,
    /** `memory` when setup returned no store and the runtime's own is in use. */
    store: z.enum(['memory', 'application']),
    principals: z.array(text),
    /** The consumer routing description from the runtime host's own compile. */
    consumer: z.looseObject({
      formatVersion: z.literal(1),
      graphDefinitionId: text,
      definitionRevision: text,
      objects: z.record(z.string(), z.unknown()),
      actions: z.record(z.string(), z.unknown()),
    }),
  }),
  z.strictObject({
    type: z.literal('failed'),
    runtimeId: text,
    diagnostics: z.array(diagnosticSchema).min(1),
  }),
  /** A bare graph whose start needs bindings only `defineApp` setup can supply. */
  z.strictObject({
    type: z.literal('not-configured'),
    runtimeId: text,
    diagnostics: z.array(diagnosticSchema).min(1),
  }),
]);

export type RuntimeMessage = z.infer<typeof runtimeMessageSchema>;

/** One principal's complete discovery, read once so a binding can answer synchronously. */
export interface DiscoverySnapshot {
  readonly overview: GraphDescription;
  /** By object definition ID. */
  readonly objects: Readonly<Record<string, ObjectDescription>>;
  /** By action definition ID. */
  readonly actions: Readonly<Record<string, ActionDescription>>;
}

export const discoverySnapshotSchema = z.strictObject({
  overview: z.looseObject({
    definitionId: text,
    definitionRevision: text,
    objects: z.record(z.string(), z.unknown()),
    actions: z.record(z.string(), z.unknown()),
  }),
  objects: z.record(z.string(), z.looseObject({ definitionId: text })),
  actions: z.record(z.string(), z.looseObject({ definitionId: text })),
});

function isProtocolError(
  error: unknown,
  name: 'ReadError' | 'ActionError',
): error is Error & {
  code: string;
  operation?: string;
  issues?: readonly unknown[];
  acceptedOptions?: readonly string[];
} {
  return (
    error instanceof Error &&
    error.name === name &&
    typeof (error as { code?: unknown }).code === 'string'
  );
}

/**
 * The host's only public failures: protocol read and action errors. Matched
 * structurally because the project's `@relate/protocol` can be a different
 * module instance from the CLI's.
 */
export function encodeError(error: unknown): WireError {
  if (isProtocolError(error, 'ReadError'))
    return {
      name: 'ReadError',
      code: error.code,
      message: error.message,
      ...(error.operation
        ? {
            details: {
              operation: error.operation,
              issues: [...(error.issues ?? [])],
              ...(error.acceptedOptions
                ? { acceptedOptions: [...error.acceptedOptions] }
                : {}),
            },
          }
        : {}),
    };

  if (isProtocolError(error, 'ActionError'))
    return { name: 'ActionError', code: error.code, message: error.message };

  return {
    name: 'Error',
    code: 'internal',
    message: 'Graph operation failed',
  };
}

export function restoreError(error: WireError): Error {
  if (error.name === 'ReadError')
    return new ReadError(
      error.code as ReadError['code'],
      error.details as ReadErrorDetails | undefined,
    );

  if (error.name === 'ActionError')
    return new ActionError(error.code as ActionError['code']);

  return Object.assign(new Error(error.message), { code: error.code });
}

/** Reads and actions report retirement through their own public error class. */
export function retiredError(operation: RuntimeOperation | 'discovery'): Error {
  return operation === 'invoke' || operation === 'getReceipt'
    ? new ActionError('runtime-retired')
    : new ReadError('runtime-retired');
}

export interface RuntimeHostArguments {
  readonly bundlePath: string;
  readonly projectRoot: string;
  readonly configPath: string;
  readonly runtimeId: string;
  /** How long the host may close on its own once the dev server is gone. */
  readonly drainTimeoutMs: number;
}

const hostArgumentsSchema = z.strictObject({
  bundlePath: text,
  projectRoot: text,
  configPath: text,
  runtimeId: text,
  drainTimeoutMs: z.number().int().positive(),
});

/** Instructions travel as JSON on argv so the environment stays the user's. */
export function encodeRuntimeHostArguments(
  input: RuntimeHostArguments,
): string {
  return JSON.stringify(input);
}

export function decodeRuntimeHostArguments(
  value: string | undefined,
): RuntimeHostArguments {
  const parsed = hostArgumentsSchema.safeParse(
    value === undefined ? undefined : JSON.parse(value),
  );

  if (!parsed.success) throw new Error('Invalid runtime host arguments');

  return parsed.data;
}

/**
 * Variables no child that imports user code inherits (the compile worker and
 * the runtime host): user code must not read the agent's key.
 */
export const withheldVariables = ['ANTHROPIC_API_KEY'] as const;

export function userCodeEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const copy = { ...env };

  for (const name of withheldVariables) delete copy[name];

  return copy;
}
