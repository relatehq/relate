import { z } from 'zod';
import { defineAction } from '../../validation/target.js';
import { access } from '../access.js';
import { AccountReview, Customer } from '../model.js';

export const AddAccountReview = defineAction({
  id: 'business.add-account-review',
  target: Customer,
  input: z.object({ note: z.string() }),
  output: z.object({ reviewId: z.string() }),
  creates: [AccountReview],
  policy: { execute: access.role('account-manager') },
});
