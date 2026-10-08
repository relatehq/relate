import { SourceAccessDenied } from 'relate/connectors';
import type { SourceConnector, SourceRecord } from 'relate/connectors';

const resources = {
  customers: { object: 'customer' },
  invoices: { object: 'invoice' },
  subscriptions: { object: 'subscription' },
  products: { object: 'product' },
  prices: { object: 'price' },
  payment_intents: { object: 'payment_intent' },
  charges: { object: 'charge' },
} as const;

const ACCOUNT_ID = /^acct_[A-Za-z0-9]+$/;

export type StripeResource = keyof typeof resources;

export interface StripeOptions {
  /** Secret/restricted account key; resolved once per operation, including identity verification. */
  apiKey:
    string | ((options: { signal: AbortSignal }) => string | Promise<string>);
  /** Pin the API version used by your source schema. */
  apiVersion: string;
  mode: 'test' | 'live';
  /** Optional Connect account. Verified against GET /v1/account, never trusted as evidence. */
  account?: string;
  /** Whole-operation deadline, including credential resolution and account verification. Default 10s. */
  timeoutMs?: number;
  /** Maximum bytes per response. Default 2 MiB. */
  maxResponseBytes?: number;
  /** Trusted transport injection for testing; production defaults to global fetch. */
  fetch?: typeof globalThis.fetch;
}

export interface StripeConnection {
  resource(
    name: StripeResource,
    options: { fields: readonly string[] },
  ): SourceConnector;
}

/** Sanitized diagnostics: no credentials, provider messages, or response bodies. */
export class StripeSourceError extends Error {
  constructor(
    readonly status?: number,
    message = status === undefined
      ? 'Stripe source request failed'
      : `Stripe source request failed (HTTP ${status})`,
  ) {
    super(message);
    this.name = 'StripeSourceError';
  }
}

type RecordData = Extract<SourceRecord, { state: 'present' }>['record'];

function object(value: unknown): value is RecordData {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function validateNumbers(value: unknown): void {
  if (
    typeof value === 'number' &&
    (!Number.isFinite(value) ||
      (Number.isInteger(value) && !Number.isSafeInteger(value)))
  )
    throw new StripeSourceError();

  if (value !== null && typeof value === 'object')
    for (const child of Object.values(value)) validateNumbers(child);
}

/** Retain ordinary failures while allowing explicit denial to stop sibling work. */
async function settleUnlessDenied<T>(
  pending: Promise<T>,
): Promise<PromiseSettledResult<T>> {
  try {
    return { status: 'fulfilled', value: await pending };
  } catch (reason) {
    if (reason instanceof SourceAccessDenied) throw reason;

    return { status: 'rejected', reason };
  }
}

function positive(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0 || value > 2_147_483_647)
    throw new Error(`Stripe ${name} must be a positive 32-bit integer`);

  return value;
}

/** Read-only API v1 resources. No ordering/version is inferred from created timestamps or request IDs. */
export function stripe(options: StripeOptions): StripeConnection {
  const { apiKey, apiVersion, mode, account } = options;
  const transport = options.fetch ?? globalThis.fetch;
  const timeoutMs = positive(options.timeoutMs ?? 10_000, 'timeoutMs');
  const maxBytes = positive(
    options.maxResponseBytes ?? 2 * 1024 * 1024,
    'maxResponseBytes',
  );

  if (!/^\d{4}-\d{2}-\d{2}(?:\.[a-z]+)?$/.test(apiVersion))
    throw new Error('Stripe apiVersion must be an explicit API version');

  if (mode !== 'test' && mode !== 'live')
    throw new Error('Invalid Stripe mode');

  if (account !== undefined && !ACCOUNT_ID.test(account))
    throw new Error('Invalid Stripe Connect account');

  const keyPattern = new RegExp(`^(?:sk|rk)_${mode}_[A-Za-z0-9]+$`);

  // A secret/restricted key belongs to one account for its lifetime, so the
  // scope verified for it is immutable credential context. Revocation still
  // surfaces as 401/403 on the record request, which forgets it.
  let verified: { key: string; scope: string } | undefined;

  async function request(
    path: string,
    headers: Headers,
    signal: AbortSignal,
  ): Promise<RecordData> {
    const response = await transport(`https://api.stripe.com/v1/${path}`, {
      method: 'GET',
      headers,
      signal,
      redirect: 'error',
    });

    if (!response.ok) {
      void response.body?.cancel().catch(() => {});

      if (response.status === 401 || response.status === 403)
        throw new SourceAccessDenied();

      throw new StripeSourceError(response.status);
    }

    const reader = response.body?.getReader();

    if (!reader) throw new StripeSourceError();

    const chunks: Uint8Array[] = [];
    let size = 0;
    let completed = false;

    try {
      while (true) {
        signal.throwIfAborted();
        const { done, value } = await reader.read();

        if (done) {
          completed = true;
          break;
        }

        size += value.byteLength;

        if (size > maxBytes) throw new StripeSourceError();

        chunks.push(value);
      }
    } finally {
      if (!completed) await reader.cancel().catch(() => {});

      reader.releaseLock();
    }

    const bytes = new Uint8Array(size);
    let offset = 0;

    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }

    const body: unknown = JSON.parse(
      new TextDecoder('utf-8', { fatal: true }).decode(bytes),
    );

    if (!object(body)) throw new StripeSourceError();

    return body;
  }

  async function operation<T>(
    caller: AbortSignal,
    work: (key: string, headers: Headers, signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    caller.throwIfAborted();
    // Aborted on completion so a denial also cancels any sibling request.
    const settled = new AbortController();
    const signal = AbortSignal.any([
      caller,
      AbortSignal.timeout(timeoutMs),
      settled.signal,
    ]);
    // Reject promptly even if a credential callback or transport ignores the signal.
    const cancelled = new Promise<never>((_, reject) =>
      signal.addEventListener('abort', () => reject(signal.reason), {
        once: true,
        signal: settled.signal,
      }),
    );

    try {
      return await Promise.race([
        cancelled,
        (async () => {
          const key =
            typeof apiKey === 'function' ? await apiKey({ signal }) : apiKey;

          signal.throwIfAborted();

          // Local misconfiguration is an outage, not provider denial, so
          // previously verified observations remain available as stale data.
          if (typeof key !== 'string' || !keyPattern.test(key))
            throw new StripeSourceError(
              undefined,
              `Stripe apiKey must be an sk_${mode}_ or rk_${mode}_ key`,
            );

          const headers = new Headers({
            Authorization: `Bearer ${key}`,
            'Stripe-Version': apiVersion,
          });

          if (account) headers.set('Stripe-Account', account);

          return work(key, headers, signal);
        })(),
      ]);
    } catch (error) {
      if (caller.aborted) throw caller.reason;

      if (signal.aborted)
        throw new StripeSourceError(
          undefined,
          'Stripe source request timed out',
        );

      if (
        error instanceof SourceAccessDenied ||
        error instanceof StripeSourceError
      )
        throw error;

      throw new StripeSourceError();
    } finally {
      settled.abort();
    }
  }

  async function identify(
    key: string,
    headers: Headers,
    signal: AbortSignal,
  ): Promise<string> {
    try {
      const result = await request('account', headers, signal);

      if (
        result.object !== 'account' ||
        typeof result.id !== 'string' ||
        !ACCOUNT_ID.test(result.id) ||
        (account && result.id !== account)
      )
        throw new SourceAccessDenied();

      verified = { key, scope: `${result.id}:${mode}` };

      return verified.scope;
    } catch (error) {
      if (error instanceof SourceAccessDenied) verified = undefined;

      throw error;
    }
  }

  async function retrieve(
    key: string,
    path: string,
    headers: Headers,
    signal: AbortSignal,
  ): Promise<[providerAccountId: string, result: RecordData]> {
    const known = verified?.key === key ? verified.scope : undefined;

    if (known) {
      try {
        return [known, await request(path, headers, signal)];
      } catch (error) {
        if (error instanceof SourceAccessDenied) verified = undefined;

        throw error;
      }
    }

    // First use of this key: verify identity without serial HTTP latency.
    // Retain outages until both calls finish, but fail immediately on denial.
    const [identityResult, recordResult] = await Promise.all([
      settleUnlessDenied(identify(key, headers, signal)),
      settleUnlessDenied(request(path, headers, signal)),
    ]);

    if (identityResult.status === 'rejected') throw identityResult.reason;

    if (recordResult.status === 'rejected') throw recordResult.reason;

    return [identityResult.value, recordResult.value];
  }

  return {
    resource(name, selection) {
      if (!Object.hasOwn(resources, name))
        throw new Error('Unsupported Stripe resource');

      const resource = resources[name];
      const fields = [...new Set(['id', ...selection.fields])];

      for (const field of fields) {
        if (
          !/^[a-z][a-z0-9_]*$/.test(field) ||
          field === 'constructor' ||
          field === 'prototype'
        )
          throw new Error('Stripe fields must be top-level field names');
      }

      return {
        identity: 'provider',
        identify: ({ signal }) => operation(signal, identify),
        async fetch(id, { signal }) {
          // Provider IDs are opaque: products/plans can have custom IDs, and
          // charge IDs are not limited to ch_. Keep them inside one URL segment.
          if (
            !id ||
            id === '.' ||
            id === '..' ||
            /[/\\]/.test(id) ||
            [...id].some(
              (char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127,
            )
          )
            throw new Error('Invalid Stripe resource ID');

          return operation(
            signal,
            async (key, headers, activeSignal): Promise<SourceRecord> => {
              const [providerAccountId, result] = await retrieve(
                key,
                `${name}/${encodeURIComponent(id)}`,
                headers,
                activeSignal,
              );

              if (result.id !== id || result.object !== resource.object)
                throw new StripeSourceError();

              // Deleted customers omit livemode. Their verified key context
              // supplies mode; reject contradictory evidence if it is present.
              if (result.deleted === true) {
                if (
                  Object.hasOwn(result, 'livemode') &&
                  result.livemode !== (mode === 'live')
                )
                  throw new SourceAccessDenied();

                return { state: 'deleted', providerAccountId };
              }

              if (result.livemode !== (mode === 'live'))
                throw new SourceAccessDenied();

              const record: RecordData = {};

              // Absent fields (for example customer `subscriptions`, which
              // Stripe only returns when expanded) are left out; the source
              // schema decides whether a missing field is acceptable.
              for (const field of fields) {
                if (!Object.hasOwn(result, field)) continue;

                validateNumbers(result[field]);
                record[field] = result[field]!;
              }

              return { state: 'present', providerAccountId, record };
            },
          );
        },
      };
    },
  };
}
