import { z } from 'zod';
import { defineAction, referenceInput } from '../../validation/target.js';
import { access } from '../access.js';
import { AccountReview, Customer } from '../model.js';

export const AddAccountReview = defineAction({
  id: 'business.add-account-review',
  input: z.object({ customer: referenceInput(Customer), note: z.string() }),
  output: z.object({ reviewId: referenceInput(AccountReview) }),
  creates: [AccountReview],
  policy: { execute: access.role('account-manager') },
});
