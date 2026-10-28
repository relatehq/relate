import { traced } from '../telemetry.js';
import type { Trace } from '../telemetry.js';

/** Non-streaming provider transport. Never records outbound authentication headers. */
export async function providerRequest(
  provider: string,
  url: string,
  init: RequestInit,
  trace?: Trace,
): Promise<unknown> {
  const body = String(init.body ?? '');

  return traced(
    trace,
    'provider',
    provider,
    { url, method: 'POST', requestBytes: Buffer.byteLength(body) },
    async (step) => {
      await trace?.emit({
        type: 'provider-request',
        provider,
        body: JSON.parse(body),
      });
      const start = performance.now();
      const response = await fetch(url, init);

      step.headersMs = performance.now() - start;
      step.httpStatus = response.status;
      step.responseHeaders = Object.fromEntries(
        [...response.headers].filter(([name]) =>
          /^(x-request-id|request-id|retry-after|openai-processing-ms|x-ratelimit-[\w-]+|anthropic-ratelimit-[\w-]+)$/.test(
            name,
          ),
        ),
      );
      const text = await response.text();

      step.responseBytes = Buffer.byteLength(text);
      step.bodyMs = performance.now() - start - Number(step.headersMs);

      if (!response.ok) {
        // Some gateways echo request headers in errors. Do not persist the key.
        const headers = new Headers(init.headers);
        const secret =
          headers.get('x-api-key') ??
          headers.get('authorization')?.replace(/^Bearer /, '');
        const safe = secret ? text.split(secret).join('[REDACTED]') : text;

        throw new Error(
          `${provider} HTTP ${response.status}: ${safe.slice(0, 2000)}`,
        );
      }

      const raw: unknown = JSON.parse(text);

      if (raw && typeof raw === 'object' && 'id' in raw)
        step.responseId = raw.id;

      return raw;
    },
  );
}
