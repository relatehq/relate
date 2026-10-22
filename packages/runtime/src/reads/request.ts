import type { ReadControls } from '@relate/protocol';
import { rejectIssues, requestIssues, type ReadOperation } from './options.js';

/**
 * Reject a request whose options are unknown to `kind` or malformed. Every issue
 * is reported at once, before any membership, record or source is consulted.
 */
export function validateReadRequest(
  request: ReadControls,
  operation = 'read',
  kind: ReadOperation = 'get',
  expandedSelection = false,
) {
  rejectIssues(
    operation,
    kind,
    requestIssues(request, kind, expandedSelection),
  );
}
