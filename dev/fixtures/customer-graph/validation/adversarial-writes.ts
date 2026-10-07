/** Fixture-only unsafe action. Typechecked; no executor is supplied here. */
import { z } from 'zod';
import { access } from '../source/access.js';
import { graph } from '../source/graph.js';
import { AccountReview, Customer, Invoice, Task } from '../source/model.js';
import {
  defineAction,
  defineGraph,
  implementAction,
  referenceInput,
} from './target.js';

export const AdversarialWrite = defineAction({
  id: 'fixture.adversarial-write',
  input: z.object({
    customer: referenceInput(Customer),
    author: z.string(),
    invoice: referenceInput(Invoice),
    existingReview: referenceInput(AccountReview).optional(),
  }),
  output: z.object({
    reviewId: referenceInput(AccountReview),
    taskId: referenceInput(Task),
  }),
  creates: [AccountReview, Task],
  policy: { execute: access.role('account-manager') },
});

// Reuse application policies unchanged. Never register this action in source/app.ts.
export const adversarialGraph = defineGraph({
  ...graph,
  actions: { ...graph.actions, adversarialWrite: AdversarialWrite },
  policies: {
    Customer: graph.policies.Customer,
    Invoice: graph.policies.Invoice,
    AccountReview: graph.policies.AccountReview,
    Task: graph.policies.Task,
  },
});

export const adversarialWrite = implementAction(
  adversarialGraph,
  AdversarialWrite,
  async ({ input, objects }) => {
    // Deliberately no reads, author correction or relationship checks.
    const review = await objects.AccountReview.create({
      customer: input.customer,
      author: input.author,
      note: 'Adversarial write',
    });
    const task = await objects.Task.create({
      customer: input.customer,
      invoice: input.invoice,
      review: input.existingReview ?? review.id,
      assignee: 'sam',
      dueDate: '2026-10-20',
    });

    return { reviewId: review.id, taskId: task.id };
  },
);
