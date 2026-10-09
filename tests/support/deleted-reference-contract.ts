import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  defineAction,
  defineGraph,
  defineObject,
  implementAction,
  native,
  nativeMembership,
  objectId,
  reference,
  referenceInput,
} from 'relate';
import { compile } from 'relate/compiler';
import { createRuntime } from '@relate/node';
import { connect } from 'relate';
import type { ObservationStore } from '@relate/runtime/storage';
import { createInvoiceGraph } from './invoice-graph.js';

const {
  access,
  ana,
  Customer,
  customers,
  graph: invoiceGraph,
  Invoice,
  invoices,
} = createInvoiceGraph();

const Task = defineObject({
  id: 'business.task',
  membership: nativeMembership(),
  properties: {
    id: objectId({ id: 'task.id' }),
    customer: reference(Customer, { id: 'task.customer' }),
    invoice: reference(Invoice, { id: 'task.invoice' }),
    assignee: native(z.string(), { id: 'task.assignee' }),
  },
});
const CreateTask = defineAction({
  id: 'business.create-task',
  input: z.object({
    customer: referenceInput(Customer),
    invoice: referenceInput(Invoice),
    assignee: z.string(),
  }),
  output: z.object({ taskId: referenceInput(Task) }),
  creates: [Task],
  policy: { execute: access.role('employee') },
});
const graph = defineGraph({
  ...invoiceGraph,
  objects: { ...invoiceGraph.objects, Task },
  actions: { createTask: CreateTask },
  policies: {
    ...invoiceGraph.policies,
    Task: {
      read: {
        gate: access.role('employee'),
        where: { customer: { portfolio: { eq: access.claims.portfolio } } },
        evidenceMaxAgeMs: 30_000,
      },
      create: {
        gate: access.role('employee'),
        where: { customer: { portfolio: { eq: access.claims.portfolio } } },
        evidenceMaxAgeMs: 30_000,
      },
    },
  },
});
const createTask = implementAction(
  graph,
  CreateTask,
  async ({ input, objects }) => {
    const task = await objects.Task.create(input);

    return { taskId: task.id };
  },
);

export function deletedReferenceContract(
  name: string,
  open: () => Promise<{ store: ObservationStore; close(): Promise<void> }>,
) {
  describe(name, () => {
    it('keeps a Task and its assignee after billing confirms its invoice was deleted', async () => {
      const backing = await open();
      const graphId = randomUUID();
      let invoiceDeleted = false;
      const relate = createRuntime({
        graph,
        graphId,
        store: backing.store,
        actionImplementations: [createTask],
        connections: [
          connect(customers, {
            providerAccountId: 'example-account',
            connectionId: 'crm',
            connector: {
              identify: async () => 'example-account',
              fetch: async (id) => ({
                providerAccountId: 'example-account',
                state: 'present',
                record: {
                  id,
                  name: 'Northwind',
                  portfolio: 'north',
                  revenue: 1,
                },
              }),
            },
          }),
          connect(invoices, {
            providerAccountId: 'example-account',
            connectionId: 'billing',
            connector: {
              identify: async () => 'example-account',
              fetch: async (id) =>
                invoiceDeleted
                  ? { providerAccountId: 'example-account', state: 'deleted' }
                  : {
                      providerAccountId: 'example-account',
                      state: 'present',
                      record: {
                        id,
                        customer_id: 'northwind',
                        status: 'open',
                        total_minor: 100,
                      },
                    },
            },
          }),
        ],
      });

      try {
        const customer = await relate.host.adopt(Customer, 'northwind');
        const invoice = await relate.host.adopt(Invoice, 'inv_1');
        const { objects, actions } = relate.as(ana);
        const receipt = await actions.createTask({
          input: { customer, invoice, assignee: 'sam' },
          idempotencyKey: 'task',
        });
        const taskId = receipt.output.taskId;
        const scope = {
          graphId,
          definitionRevision: compile(graph).definitionRevision,
        };
        const before = await backing.store.native!.load(scope, Task.id, taskId);

        expect(before?.values).toEqual({
          'task.customer': customer,
          'task.invoice': invoice,
          'task.assignee': 'sam',
        });
        expect(
          await objects.Task.get(taskId, { select: ['assignee', 'invoice'] }),
        ).toMatchObject({
          status: 'ok',
          data: { assignee: 'sam', invoice },
          meta: { completeness: 'complete' },
        });

        invoiceDeleted = true;
        expect(await objects.Invoice.get(invoice, { refresh: true })).toEqual({
          status: 'not-found',
        });
        const result = await objects.Task.get(taskId, {
          evidence: 'full',
          select: ['assignee', 'invoice'],
        });

        expect(result).toMatchObject({
          status: 'ok',
          data: { assignee: 'sam' },
          meta: {
            completeness: 'partial',
            degraded: true,
            fields: {
              assignee: { status: 'available' },
              invoice: { status: 'unavailable' },
            },
          },
        });

        if (result.status !== 'ok') throw new Error('Expected surviving Task');

        expect(result.data).not.toHaveProperty('invoice');
        expect(JSON.stringify(result)).not.toContain(invoice);
        // Withholding a field must not delete the Task or clear its stored link.
        expect(
          await backing.store.native!.load(scope, Task.id, taskId),
        ).toEqual(before);
        await expect(
          objects.Task.get(taskId, {
            select: ['assignee', 'invoice'],
            requireComplete: true,
          }),
        ).rejects.toMatchObject({ code: 'incomplete' });
        expect(
          await relate
            .as({ ...ana, claims: { portfolio: 'south' } })
            .objects.Task.get(taskId, { select: ['assignee', 'invoice'] }),
        ).toEqual({ status: 'not-found' });
      } finally {
        await relate.close();
        await backing.close();
      }
    });
  });
}
