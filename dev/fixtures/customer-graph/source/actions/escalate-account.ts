import { z } from 'zod';
import { defineAction, referenceInput } from '../../validation/target.js';
import { access } from '../access.js';
import { AccountReview, Customer, Task } from '../model.js';

export const EscalateAccount = defineAction({
  id: 'business.escalate-account',
  input: z.object({
    customer: referenceInput(Customer),
    note: z.string(),
    assignee: z.string(),
    dueDate: z.string(),
  }),
  output: z.object({
    reviewId: referenceInput(AccountReview),
    taskIds: z.array(referenceInput(Task)),
  }),
  creates: [AccountReview, Task],
  errors: {
    inactive: z.object({}),
    tooManyInvoices: z.object({ limit: z.number().int().positive() }),
  },
  policy: { execute: access.role('account-manager') },
});
