import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { TestWorkflowEnvironment } from '@temporalio/testing';
import { Worker, bundleWorkflowCode } from '@temporalio/worker';
import { createActivities, loseFirstCompletion } from '../src/activities.js';
import { openRelate } from '../src/runtime.js';
import type { approvalWorkflow } from '../src/workflows.js';

const workflowsPath = fileURLToPath(
  new URL('../src/workflows.ts', import.meta.url),
);

test(
  'Relate + real Temporal server: persistence, retries, authorization and decisions',
  { timeout: 180_000 },
  async (t) => {
    const databaseUrl = process.env.RELATE_TEST_DATABASE_URL;

    assert.ok(
      databaseUrl,
      'Set RELATE_TEST_DATABASE_URL to a disposable Postgres database',
    );
    const env = await TestWorkflowEnvironment.createLocal();

    t.after(() => env.teardown());
    const workflowBundle = await bundleWorkflowCode({ workflowsPath });
    const owner = { id: 'ada', roles: ['member'], claims: {} };

    for (const scenario of [
      'restart-and-retry',
      'revoked',
      'other-owner',
      'rejected',
      'expired',
    ] as const) {
      await t.test(scenario, async () => {
        const graphId = `temporal-poc-${randomUUID()}`;
        const taskQueue = graphId;
        let runtime = await openRelate(databaseUrl, graphId);
        let revoked = false;
        let completionAttempts = 0;
        const resolvePrincipal = async (id: string) => ({
          id,
          roles: revoked ? [] : ['member'],
          claims: {},
        });
        const makeWorker = () => {
          const activities = loseFirstCompletion(
            createActivities(runtime.relate, resolvePrincipal),
          );

          return Worker.create({
            connection: env.nativeConnection,
            taskQueue,
            workflowBundle,
            activities: {
              ...activities,
              async completeRequest(
                input: Parameters<typeof activities.completeRequest>[0],
              ) {
                completionAttempts++;

                return activities.completeRequest(input);
              },
            },
          });
        };

        try {
          const receipt = await runtime.relate.as(owner).actions.submit({
            input: { title: 'Approve customer onboarding' },
            idempotencyKey: 'submit',
          });
          const handle = await env.client.workflow.start<
            typeof approvalWorkflow
          >('approvalWorkflow', {
            workflowId: graphId,
            taskQueue,
            args: [
              {
                requestId: receipt.output.requestId,
                actorId: scenario === 'other-owner' ? 'bob' : owner.id,
              },
              scenario === 'expired' ? 100 : 60_000,
            ],
          });
          let worker = await makeWorker();

          if (scenario === 'restart-and-retry' || scenario === 'revoked') {
            await worker.runUntil(async () => {
              const deadline = Date.now() + 15_000;

              while ((await handle.query<string>('phase')) !== 'waiting') {
                assert.ok(
                  Date.now() < deadline,
                  'Workflow did not reach approval wait',
                );
                await delay(20);
              }
            });
            // Stop the Worker and close its database pool. Recreate both over the
            // same persisted graph, while Temporal retains the waiting execution.
            await runtime.close();
            runtime = await openRelate(databaseUrl, graphId);
            revoked = scenario === 'revoked';
            worker = await makeWorker();
          }

          await worker.runUntil(async () => {
            if (scenario !== 'expired' && scenario !== 'other-owner')
              await handle.signal('decide', scenario !== 'rejected');

            if (scenario === 'revoked' || scenario === 'other-owner') {
              await assert.rejects(handle.result(), (error: unknown) => {
                const failure = error as {
                  cause?: { cause?: { type?: string; nonRetryable?: boolean } };
                };

                assert.equal(failure.cause?.cause?.type, 'Authorization');
                assert.equal(failure.cause?.cause?.nonRetryable, true);

                return true;
              });
            } else {
              const result = await handle.result();

              assert.equal(
                result.status,
                scenario === 'restart-and-retry' ? 'approved' : scenario,
              );
            }
          });
          const approvals = [];

          for await (const row of runtime.relate
            .as(owner)
            .objects.Approval.query({ select: ['id'] }))
            approvals.push(row);

          assert.equal(
            approvals.length,
            scenario === 'restart-and-retry' ? 1 : 0,
          );
          assert.equal(
            completionAttempts,
            scenario === 'restart-and-retry'
              ? 2
              : scenario === 'revoked'
                ? 1
                : 0,
          );
          // Replay real history with the same Workflow bundle; no Activities run.
          await Worker.runReplayHistory(
            { workflowBundle },
            await handle.fetchHistory(),
          );
          console.log(
            JSON.stringify({
              scenario,
              approvals: approvals.length,
              completionAttempts,
              replay: 'passed',
            }),
          );
        } finally {
          await runtime.close();
        }
      });
    }
  },
);
