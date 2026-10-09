import type { ReadRequest } from '@relate/protocol';
import { rejectIssues, requestIssues, type ReadOperation } from './options.js';

/**
 * Reject a request whose options are unknown to `kind` or malformed. Every issue
 * is reported at once, before any membership, record or source is consulted.
 */
export function validateReadRequest(
  request: ReadRequest,
  operation = 'read',
  kind: ReadOperation = 'get',
) {
  rejectIssues(operation, kind, requestIssues(request, kind));
}
