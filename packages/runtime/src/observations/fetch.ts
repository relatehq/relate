import { accepts } from 'relate/model';
import type { Manifest } from 'relate/model';
import type { Json } from '@relate/protocol';
import type { Observation } from '../storage.js';
import type { AnySourceConnector, SourceResult } from 'relate/connectors';
import { SourceAccessDenied } from 'relate/connectors';

export class InvalidObservation extends Error {}

export async function boundedFetch(
  connector: AnySourceConnector,
  sourceRecordId: string,
  timeoutMs: number,
  providerAccountId: string | null,
): Promise<SourceResult> {
  const result = await boundedSourceCall<SourceResult>(
    (signal) => connector.fetch(sourceRecordId, { signal }),
    timeoutMs,
  );

  // Provider mode requires account evidence; application mode must not claim it.
  // A mismatch is a denial and must not enable stale fallback.
  if (
    connector.identity === 'application'
      ? providerAccountId !== null || result?.providerAccountId !== undefined
      : providerAccountId === null ||
        result?.providerAccountId !== providerAccountId
  )
    throw new SourceAccessDenied();

  return result;
}

export async function verifyAccount(
  connector: AnySourceConnector,
  providerAccountId: string | null,
  timeoutMs: number,
): Promise<void> {
  if (connector.identity === 'application') {
    if (providerAccountId !== null) throw new SourceAccessDenied();

    return;
  }

  const actual = await boundedSourceCall(
    (signal) => connector.identify({ signal }),
    timeoutMs,
  );

  if (actual !== providerAccountId) throw new SourceAccessDenied();
}

async function boundedSourceCall<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;

  try {
    return await Promise.race([
      Promise.resolve().then(() => operation(controller.signal)),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new Error('Source timeout'));
        }, timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function validJson(value: unknown): boolean {
  if (value === null || typeof value === 'string' || typeof value === 'boolean')
    return true;

  if (typeof value === 'number') return Number.isFinite(value);

  if (Array.isArray(value)) return value.every(validJson);

  return (
    typeof value === 'object' &&
    value !== null &&
    Object.getPrototypeOf(value) === Object.prototype &&
    Object.values(value).every(validJson)
  );
}

export function observation(
  result: SourceResult,
  resource: Manifest['sources'][number],
  object: Manifest['objects'][number],
  sourceRecordId: string,
  token: string,
  observedAt: number,
): Observation {
  if (!result || !['present', 'deleted'].includes(result.state))
    throw new InvalidObservation();

  if (
    result.version &&
    (!result.version.domain || !/^(0|[1-9][0-9]*)$/.test(result.version.value))
  )
    throw new InvalidObservation();

  if (result.state === 'deleted')
    return {
      state: 'deleted',
      raw: {},
      values: {},
      token,
      observedAt,
      ...(result.version ? { version: result.version } : {}),
    };

  if (
    !validJson(result.record) ||
    Array.isArray(result.record) ||
    !result.record ||
    result.record[resource.idField] !== sourceRecordId
  )
    throw new InvalidObservation();

  for (const [name, schema] of Object.entries(resource.fields)) {
    if (
      !accepts(
        schema,
        Object.hasOwn(result.record, name) ? result.record[name] : undefined,
      )
    )
      throw new InvalidObservation();
  }

  const values: Record<string, Json> = {};

  for (const property of object.properties) {
    if (
      (property.origin.kind === 'source' ||
        property.origin.kind === 'reference') &&
      Object.hasOwn(result.record, property.origin.field)
    )
      values[property.id] = result.record[property.origin.field]!;
  }

  return {
    state: 'present',
    raw: structuredClone(result.record),
    values,
    token,
    observedAt,
    ...(result.version ? { version: { ...result.version } } : {}),
  };
}
