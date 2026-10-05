import { accepts } from 'relate/model';
import type { Manifest } from 'relate/model';
import type { Json } from '@relate/protocol';
import type { Observation, SourceVersion } from '../storage.js';

export type SourceRecord =
  | { state: 'present'; record: Record<string, Json>; version?: SourceVersion }
  | { state: 'deleted'; version?: SourceVersion };

export interface SourceConnector {
  /** Deletion must be affirmative authoritative evidence; permission denial is an error. */
  fetch(
    sourceRecordId: string,
    options: { signal: AbortSignal },
  ): Promise<SourceRecord>;
}

export class InvalidObservation extends Error {}

export async function boundedFetch(
  connector: SourceConnector,
  sourceRecordId: string,
  timeoutMs: number,
): Promise<SourceRecord> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;

  try {
    return await Promise.race([
      Promise.resolve().then(() =>
        connector.fetch(sourceRecordId, { signal: controller.signal }),
      ),
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
  result: SourceRecord,
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
      property.origin.kind === 'source' &&
      Object.hasOwn(result.record, property.origin.field)
    )
      values[property.name] = result.record[property.origin.field]!;
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
