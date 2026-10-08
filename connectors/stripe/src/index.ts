import { SourceAccessDenied } from 'relate/connectors';
import type { SourceConnector, SourceRecord } from 'relate/connectors';

const resources = {
  customers: { object: 'customer', prefix: 'cus_' },
  invoices: { object: 'invoice', prefix: 'in_' },
  subscriptions: { object: 'subscription', prefix: 'sub_' },
  products: { object: 'product', prefix: 'prod_' },
  prices: { object: 'price', prefix: 'price_' },
  payment_intents: { object: 'payment_intent', prefix: 'pi_' },
  charges: { object: 'charge', prefix: 'ch_' },
} as const;

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
  constructor(readonly status?: number) {
    super(
      status === undefined
        ? 'Stripe source request failed'
        : `Stripe source request failed (HTTP ${status})`,
    );
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

  if (account !== undefined && !/^acct_[A-Za-z0-9]+$/.test(account))
    throw new Error('Invalid Stripe Connect account');

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

    try {
      while (true) {
        signal.throwIfAborted();
        const { done, value } = await reader.read();

        if (done) break;

        size += value.byteLength;

        if (size > maxBytes) throw new StripeSourceError();

        chunks.push(value);
      }
    } finally {
      await reader.cancel();
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
    work: (headers: Headers, signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    const signal = AbortSignal.any([caller, AbortSignal.timeout(timeoutMs)]);

    signal.throwIfAborted();
    let abort: () => void = () => {};
    const cancelled = new Promise<never>((_, reject) => {
      abort = () => reject(signal.reason);
      signal.addEventListener('abort', abort, { once: true });
    });

    try {
      return await Promise.race([
        cancelled,
        (async () => {
          const key =
            typeof apiKey === 'function' ? await apiKey({ signal }) : apiKey;

          signal.throwIfAborted();

          if (
            typeof key !== 'string' ||
            !new RegExp(`^(?:sk|rk)_${mode}_[A-Za-z0-9]+$`).test(key)
          )
            throw new SourceAccessDenied();

          const headers = new Headers({
            Authorization: `Bearer ${key}`,
            'Stripe-Version': apiVersion,
          });

          if (account) headers.set('Stripe-Account', account);

          return work(headers, signal);
        })(),
      ]);
    } catch (error) {
      if (signal.aborted) throw signal.reason;

      if (
        error instanceof SourceAccessDenied ||
        error instanceof StripeSourceError
      )
        throw error;

      throw new StripeSourceError();
    } finally {
      signal.removeEventListener('abort', abort);
    }
  }

  async function identify(
    headers: Headers,
    signal: AbortSignal,
  ): Promise<string> {
    const result = await request('account', headers, signal);

    if (
      result.object !== 'account' ||
      typeof result.id !== 'string' ||
      !/^acct_[A-Za-z0-9]+$/.test(result.id) ||
      (account && result.id !== account)
    )
      throw new SourceAccessDenied();

    return `${result.id}:${mode}`;
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
          if (!id.startsWith(resource.prefix) || !/^[A-Za-z0-9_]+$/.test(id))
            throw new Error('Invalid Stripe resource ID');

          return operation(
            signal,
            async (headers, activeSignal): Promise<SourceRecord> => {
              const providerAccountId = await identify(headers, activeSignal);

              activeSignal.throwIfAborted();
              const result = await request(
                `${name}/${encodeURIComponent(id)}`,
                headers,
                activeSignal,
              );

              if (result.id !== id || result.object !== resource.object)
                throw new StripeSourceError();

              if (result.deleted === true)
                return { state: 'deleted', providerAccountId };

              if (result.livemode !== (mode === 'live'))
                throw new SourceAccessDenied();

              const record: RecordData = {};

              for (const field of fields) {
                if (!Object.hasOwn(result, field))
                  throw new StripeSourceError();

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
