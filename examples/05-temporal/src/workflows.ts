import {
  condition,
  defineQuery,
  defineSignal,
  proxyActivities,
  setHandler,
  workflowInfo,
} from '@temporalio/workflow';
import type { Activities, ApprovalInput, ApprovalResult } from './contracts.js';

export const decide = defineSignal<[boolean]>('decide');
export const phase = defineQuery<string>('phase');

const activities = proxyActivities<Activities>({
  startToCloseTimeout: '10 seconds',
  retry: {
    initialInterval: '100 milliseconds',
    maximumInterval: '1 second',
    maximumAttempts: 3,
  },
});

export async function approvalWorkflow(
  input: ApprovalInput,
  timeoutMs = 86_400_000,
): Promise<ApprovalResult> {
  let decision: boolean | undefined;
  let state = 'reading';

  // First decision wins, including an early signal received during the read.
  setHandler(decide, (value) => {
    if (typeof value === 'boolean' && decision === undefined) decision = value;
  });
  setHandler(phase, () => state);
  await activities.readRequest(input);
  state = 'waiting';

  if (!(await condition(() => decision !== undefined, timeoutMs))) {
    state = 'expired';

    return { status: 'expired' };
  }

  if (!decision) {
    state = 'rejected';

    return { status: 'rejected' };
  }

  state = 'completing';
  const result = await activities.completeRequest({
    ...input,
    // Stable across Activity retries and Workflow replay. A new Workflow run
    // deliberately gets a new command identity; this is not business deduplication.
    commandId: `${workflowInfo().workflowId}/${workflowInfo().runId}/complete-v1`,
  });

  state = 'approved';

  return { status: 'approved', ...result };
}
