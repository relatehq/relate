import { z } from 'zod';
import { defineAction, referenceInput } from '../../validation/target.js';
import { access } from '../access.js';
import { AccountReview, Invoice } from '../model.js';

export const ReviewInvoice = defineAction({
  id: 'business.review-invoice',
  input: z.object({ invoice: referenceInput(Invoice), note: z.string() }),
  output: z.object({ reviewId: z.string() }),
  creates: [AccountReview],
  policy: { execute: access.role('account-manager') },
});
