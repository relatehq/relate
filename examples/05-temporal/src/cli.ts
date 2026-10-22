import { fileURLToPath } from 'node:url';
import { Connection, Client } from '@temporalio/client';
import { NativeConnection, Worker } from '@temporalio/worker';
import { ApplicationFailure } from '@temporalio/common';
import { createActivities } from './activities.js';
import { openRelate } from './runtime.js';
import type { approvalWorkflow } from './workflows.js';

const [command, workflowId, decision] = process.argv.slice(2);
const address = process.env.TEMPORAL_ADDRESS ?? 'localhost:7233';
const taskQueue = 'relate-approval-poc';
const owner = { id: 'ada', roles: ['member'], claims: {} };

if (
  !['worker', 'start', 'decide', 'result'].includes(command ?? '') ||
  (command !== 'worker' && !workflowId) ||
  (command === 'decide' && !['approve', 'reject'].includes(decision ?? ''))
) {
  throw new Error(
    'Usage: demo worker | start <unique-id> | decide <id> approve|reject | result <id>',
  );
}

if (command === 'worker') {
  const databaseUrl = process.env.DATABASE_URL;

  if (!databaseUrl) throw new Error('Set DATABASE_URL');

  const runtime = await openRelate(databaseUrl, 'temporal-approval-demo');

  try {
    const connection = await NativeConnection.connect({ address });

    try {
      const worker = await Worker.create({
        connection,
        taskQueue,
        workflowsPath: fileURLToPath(
          new URL('./workflows.ts', import.meta.url),
        ),
        activities: createActivities(runtime.relate, async (actorId) => {
          // Local demo identity directory. Production must authenticate starts
          // and signals, and resolve current grants from its trusted directory.
          if (actorId !== owner.id)
            throw ApplicationFailure.nonRetryable(
              'Unknown actor',
              'Authorization',
            );

          return owner;
        }),
      });

      await worker.run();
    } finally {
      await connection.close();
    }
  } finally {
    await runtime.close();
  }
} else {
  const connection = await Connection.connect({ address });

  try {
    const client = new Client({ connection });

    if (command === 'start') {
      const databaseUrl = process.env.DATABASE_URL;

      if (!databaseUrl) throw new Error('Set DATABASE_URL');

      const runtime = await openRelate(databaseUrl, 'temporal-approval-demo');

      try {
        const receipt = await runtime.relate.as(owner).actions.submit({
          input: { title: 'Approve customer onboarding' },
          idempotencyKey: `submit/${workflowId}`,
        });
        // There is deliberately no claim of an atomic Relate + Temporal commit.
        // Retrying this command reuses both the submission key and Workflow ID.
        const handle = await client.workflow.start<typeof approvalWorkflow>(
          'approvalWorkflow',
          {
            taskQueue,
            workflowId: workflowId!,
            workflowIdReusePolicy: 'REJECT_DUPLICATE',
            args: [{ requestId: receipt.output.requestId, actorId: owner.id }],
          },
        );

        console.log(
          JSON.stringify({
            workflowId: handle.workflowId,
            requestId: receipt.output.requestId,
          }),
        );
      } finally {
        await runtime.close();
      }
    } else {
      const handle = client.workflow.getHandle(workflowId!);

      if (command === 'decide')
        await handle.signal('decide', decision === 'approve');
      else console.log(JSON.stringify(await handle.result()));
    }
  } finally {
    await connection.close();
  }
}
