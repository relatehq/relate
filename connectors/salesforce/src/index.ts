import { SourceAccessDenied } from 'relate/connectors';
import type { SourceConnector, SourceRecord } from 'relate/connectors';

export interface SalesforceCredentials {
  /** HTTPS origin returned by your OAuth flow. Never supply an untrusted request URL. */
  instanceUrl: string;
  accessToken: string;
}

export interface SalesforceOptions {
  /** Resolve a fresh, matching origin/token pair once per operation. */
  credentials:
    | SalesforceCredentials
    | ((options: {
        signal: AbortSignal;
      }) => SalesforceCredentials | Promise<SalesforceCredentials>);
  /** Explicit REST API version, for example 67.0. */
  apiVersion: string;
  /** Whole-operation deadline, including credentials and identity. Default 10s. */
  timeoutMs?: number;
  /** Maximum bytes per response. Default 2 MiB. */
  maxResponseBytes?: number;
  /** Trusted transport injection for tests. */
  fetch?: typeof globalThis.fetch;
}

export interface SalesforceConnection {
  resource(
    name: 'Account',
    options: { fields: readonly string[] },
  ): SourceConnector;
}

/** Sanitized diagnostics never contain credentials or provider response bodies. */
export class SalesforceSourceError extends Error {
  constructor(readonly status?: number) {
    super(
      status === undefined
        ? 'Salesforce source request failed'
        : `Salesforce source request failed (HTTP ${status})`,
    );
    this.name = 'SalesforceSourceError';
  }
}

/**
 * Salesforce rejected a selected field or object. It reports a misspelled field
 * and one hidden by field-level security with the same code, so this stays a
 * denial (never replaying cached values) while naming the cause for diagnosis.
 */
export class SalesforceSelectionDenied extends SourceAccessDenied {
  constructor(readonly errorCode: string) {
    super();
    this.message = `Salesforce rejected the selected fields (${errorCode}); check field names and field-level security`;
    this.name = 'SalesforceSelectionDenied';
  }
}

type RecordData = Extract<SourceRecord, { state: 'present' }>['record'];

function object(value: unknown): value is RecordData {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Normalize case-sensitive 15-character IDs and validate 18-character checksums. */
function canonicalId(value: unknown, prefix: string): string {
  if (
    typeof value !== 'string' ||
    !/^[a-zA-Z0-9]{15}(?:[A-Z0-5]{3})?$/.test(value) ||
    !value.startsWith(prefix)
  )
    throw new SalesforceSourceError();

  const short = value.slice(0, 15);
  let suffix = '';

  for (let group = 0; group < 3; group++) {
    let bits = 0;

    for (let index = 0; index < 5; index++)
      if (/[A-Z]/.test(short[group * 5 + index]!)) bits |= 1 << index;

    suffix += 'ABCDEFGHIJKLMNOPQRSTUVWXYZ012345'[bits];
  }

  const id = short + suffix;

  if (value.length === 18 && value !== id) throw new SalesforceSourceError();

  return id;
}

function positive(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > 2_147_483_647)
    throw new Error('Salesforce limits must be positive 32-bit integers');

  return value;
}

function validValue(value: unknown): void {
  if (
    typeof value === 'number' &&
    (!Number.isFinite(value) ||
      (Number.isInteger(value) && !Number.isSafeInteger(value)))
  )
    throw new SalesforceSourceError();

  if (value !== null && typeof value === 'object')
    for (const child of Object.values(value)) validValue(child);
}

/** Read-only Account access; no CLI, discovery, writes, or inferred source ordering. */
export function salesforce(options: SalesforceOptions): SalesforceConnection {
  if (!/^\d{2,3}\.0$/.test(options.apiVersion))
    throw new Error(
      'Salesforce apiVersion must be explicit (for example 67.0)',
    );

  const timeoutMs = positive(options.timeoutMs ?? 10_000);
  const maxBytes = positive(options.maxResponseBytes ?? 2 * 1024 * 1024);
  const transport = options.fetch ?? globalThis.fetch;

  async function operation<T>(
    caller: AbortSignal,
    work: (get: (path: string) => Promise<RecordData>) => Promise<T>,
  ): Promise<T> {
    caller.throwIfAborted();
    const completion = new AbortController();
    const deadline = new AbortController();
    const timer = setTimeout(() => deadline.abort(), timeoutMs);
    const signal = AbortSignal.any([
      caller,
      deadline.signal,
      completion.signal,
    ]);
    const cancelled = new Promise<never>((_, reject) =>
      signal.addEventListener('abort', () => reject(signal.reason), {
        once: true,
        signal: completion.signal,
      }),
    );

    try {
      return await Promise.race([
        cancelled,
        (async () => {
          const credentials =
            typeof options.credentials === 'function'
              ? await options.credentials({ signal })
              : options.credentials;

          signal.throwIfAborted();
          const origin = new URL(credentials.instanceUrl);

          if (
            origin.protocol !== 'https:' ||
            origin.username ||
            origin.password ||
            origin.search ||
            origin.hash ||
            origin.pathname !== '/' ||
            !credentials.accessToken ||
            /\s/.test(credentials.accessToken)
          )
            throw new SalesforceSourceError();

          const headers = {
            Authorization: `Bearer ${credentials.accessToken}`,
          };

          async function get(path: string): Promise<RecordData> {
            signal.throwIfAborted();
            const response = await transport(`${origin.origin}${path}`, {
              headers,
              signal,
              redirect: 'error',
              method: 'GET',
            });

            if (response.status === 401 || response.status === 403) {
              void response.body?.cancel().catch(() => {});
              throw new SourceAccessDenied();
            }

            const reader = response.body?.getReader();

            if (!reader) throw new SalesforceSourceError(response.status);

            const cancelRead = () => {
              void reader.cancel().catch(() => {});
            };

            signal.addEventListener('abort', cancelRead, { once: true });
            const chunks: Uint8Array[] = [];
            let size = 0;
            let done = false;

            try {
              while (true) {
                signal.throwIfAborted();
                const part = await reader.read();

                if (part.done) {
                  done = true;
                  break;
                }

                size += part.value.byteLength;

                if (size > maxBytes)
                  throw new SalesforceSourceError(response.status);

                chunks.push(part.value);
              }
            } finally {
              signal.removeEventListener('abort', cancelRead);

              if (!done) void reader.cancel().catch(() => {});

              reader.releaseLock();
            }

            const bytes = new Uint8Array(size);
            let offset = 0;

            for (const chunk of chunks) {
              bytes.set(chunk, offset);
              offset += chunk.byteLength;
            }

            let body: unknown;

            try {
              body = JSON.parse(
                new TextDecoder('utf-8', { fatal: true }).decode(bytes),
              );
            } catch {
              // Keep the status of non-JSON error pages, such as proxy 502s.
              throw new SalesforceSourceError(
                response.ok ? undefined : response.status,
              );
            }

            if (!response.ok) {
              // Salesforce can encode object/field permission errors as HTTP 400.
              const codes = Array.isArray(body)
                ? body.flatMap((entry) =>
                    object(entry) && typeof entry.errorCode === 'string'
                      ? [entry.errorCode]
                      : [],
                  )
                : [];
              const selection = codes.find((code) =>
                ['INVALID_FIELD', 'INVALID_TYPE'].includes(code),
              );

              if (
                codes.some((code) =>
                  [
                    'INVALID_SESSION_ID',
                    'INSUFFICIENT_ACCESS',
                    'INSUFFICIENT_ACCESS_OR_READONLY',
                    'API_DISABLED_FOR_ORG',
                  ].includes(code),
                )
              )
                throw new SourceAccessDenied();

              if (selection) throw new SalesforceSelectionDenied(selection);

              throw new SalesforceSourceError(response.status);
            }

            if (!object(body)) throw new SalesforceSourceError();

            return body;
          }

          return work(get);
        })(),
      ]);
    } catch (error) {
      if (caller.aborted) throw caller.reason;

      if (
        error instanceof SourceAccessDenied ||
        error instanceof SalesforceSourceError
      )
        throw error;

      throw new SalesforceSourceError();
    } finally {
      clearTimeout(timer);
      completion.abort();
    }
  }

  async function identify(
    get: (path: string) => Promise<RecordData>,
  ): Promise<string> {
    const identity = await get('/services/oauth2/userinfo');

    return canonicalId(identity.organization_id, '00D');
  }

  return {
    resource(name, selection) {
      if (name !== 'Account')
        throw new Error('Unsupported Salesforce resource');

      // Salesforce field names are case-insensitive: keep the first spelling of each.
      const byKey = new Map<string, string>();

      for (const field of ['Id', 'IsDeleted', ...selection.fields]) {
        if (
          !/^[A-Za-z][A-Za-z0-9_]*$/.test(field) ||
          ['constructor', 'prototype', 'attributes'].includes(
            field.toLowerCase(),
          )
        )
          throw new Error(
            'Salesforce fields must be top-level API field names',
          );

        if (!byKey.has(field.toLowerCase()))
          byKey.set(field.toLowerCase(), field);
      }

      const fields = [...byKey.values()];

      return {
        identity: 'provider',
        identify: ({ signal }) => operation(signal, identify),
        async fetch(id, { signal }) {
          const recordId = canonicalId(id, '001');

          return operation(signal, async (get) => {
            const query = `SELECT ${fields.join(',')} FROM Account WHERE Id = '${recordId}' LIMIT 1`;
            // Verify every operation with the same origin/token pair as the record read.
            // Nothing from the query is used unless the identity check also succeeds.
            const [providerAccountId, result] = await Promise.all([
              identify(get),
              get(
                `/services/data/v${options.apiVersion}/queryAll?q=${encodeURIComponent(query)}`,
              ),
            ]);

            if (
              result.done !== true ||
              !Array.isArray(result.records) ||
              result.totalSize !== result.records.length ||
              result.records.length > 1
            )
              throw new SalesforceSourceError();

            // No row means sharing access was revoked or the record was purged from the
            // Recycle Bin. Salesforce does not tell these apart for the running user, so
            // never replay cached data or invent a tombstone.
            if (result.records.length === 0) throw new SourceAccessDenied();

            const row = result.records[0];

            if (
              !object(row) ||
              canonicalId(row.Id, '001') !== recordId ||
              !object(row.attributes) ||
              row.attributes.type !== name ||
              typeof row.IsDeleted !== 'boolean'
            )
              throw new SalesforceSourceError();

            if (row.IsDeleted) return { state: 'deleted', providerAccountId };

            // Rows use Salesforce's canonical spelling; return the selected spelling.
            const columns = new Map(
              Object.keys(row).map((key) => [key.toLowerCase(), key]),
            );
            const record: RecordData = {};

            for (const field of fields) {
              const column = columns.get(field.toLowerCase());

              if (column === undefined) throw new SourceAccessDenied();

              validValue(row[column]);
              record[field] = row[column]!;
            }

            // Keep the application's adopted source ID, including its 15-character form.
            record.Id = id;

            return { state: 'present', providerAccountId, record };
          });
        },
      };
    },
  };
}
