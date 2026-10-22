import { activityInfo } from '@temporalio/activity';
import { ApplicationFailure } from '@temporalio/common';
import { ActionError } from '@relate/node';
import type { Relate } from '@relate/node';

import type { Activities } from './contracts.js';
import { referenceInput } from 'relate';
import { Request } from './model.js';
import type { graph } from './model.js';

type Principal = Parameters<Relate<typeof graph>['as']>[0];

export function createActivities(
  relate: Relate<typeof graph>,
  resolvePrincipal: (actorId: string) => Promise<Principal>,
): Activities {
  async function consumer(actorId: string) {
    // Resolve current roles on EVERY attempt; never trust roles in Workflow input.
    const principal = await resolvePrincipal(actorId);

    if (principal.id !== actorId)
      throw ApplicationFailure.nonRetryable(
        'Identity mismatch',
        'Authorization',
      );

    return relate.as(principal);
  }

  return {
    async readRequest(input) {
      const api = await consumer(input.actorId);
      const requestId = referenceInput(Request).parse(input.requestId);
      const request = await api.objects.Request.get(requestId, {
        select: ['id'],
      });

      if (request.status !== 'ok')
        throw ApplicationFailure.nonRetryable(
          'Request unavailable',
          'Authorization',
        );

      return { requestId: request.id };
    },
    async completeRequest(input) {
      const api = await consumer(input.actorId);
      const requestId = referenceInput(Request).parse(input.requestId);
      // Reauthorize even when a previous attempt already committed. Do not pass
      // the entire receipt or business record into Temporal history.
      const request = await api.objects.Request.get(requestId, {
        select: ['id'],
      });

      if (request.status !== 'ok')
        throw ApplicationFailure.nonRetryable(
          'Request unavailable',
          'Authorization',
        );

      try {
        const receipt = await api.actions.complete({
          input: { requestId },
          idempotencyKey: input.commandId,
        });

        return { approvalId: receipt.output.approvalId };
      } catch (error) {
        if (error instanceof ActionError) {
          // Conservative POC policy: reconcile Relate failures rather than blindly
          // retrying an uncertain business write. Transport errors may retry.
          throw ApplicationFailure.nonRetryable(
            'Relate action failed',
            `Relate:${error.code}`,
          );
        }

        throw error;
      }
    },
  };
}

// Test/demo-only fault: the business commit succeeded but Temporal did not get
// its result. The next attempt must reuse the same Relate idempotency key.
export function loseFirstCompletion(activities: Activities): Activities {
  return {
    ...activities,
    async completeRequest(input) {
      const result = await activities.completeRequest(input);

      if (activityInfo().attempt === 1)
        throw new Error('Injected lost completion acknowledgement');

      return result;
    },
  };
}
