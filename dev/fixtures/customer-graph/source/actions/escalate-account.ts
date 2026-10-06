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
  output: z.object({ reviewId: z.string(), taskIds: z.array(z.string()) }),
  creates: [AccountReview, Task],
  policy: { execute: access.role('account-manager') },
});
