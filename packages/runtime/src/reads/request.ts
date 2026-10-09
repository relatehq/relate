import { ReadError } from '@relate/protocol';
import type { ReadRequest } from '@relate/protocol';

export function validateReadRequest(request: ReadRequest) {
  if (!request || typeof request !== 'object' || Array.isArray(request))
    throw new ReadError('invalid-request');

  const maxAge = request.maxAgeMs ?? 60_000,
    timeout = request.timeoutMs ?? 3_000;

  if (
    !Number.isFinite(maxAge) ||
    maxAge < 0 ||
    !Number.isFinite(timeout) ||
    timeout <= 0 ||
    timeout > 10_000 ||
    (request.evidence !== undefined &&
      !['compact', 'full'].includes(request.evidence)) ||
    (request.stale !== undefined &&
      !['allow', 'omit'].includes(request.stale)) ||
    (request.select !== undefined &&
      (!Array.isArray(request.select) ||
        request.select.length > 100 ||
        request.select.some(
          (p) =>
            typeof p !== 'string' ||
            ['__proto__', 'constructor', 'prototype'].includes(p),
        ))) ||
    (request.refresh !== undefined && typeof request.refresh !== 'boolean') ||
    (request.requireComplete !== undefined &&
      typeof request.requireComplete !== 'boolean')
  )
    throw new ReadError('invalid-request');
}
