import { ReviewInvoice } from './actions/review-invoice.js';
import { AddAccountReview } from './actions/add-account-review.js';
import { EscalateAccount } from './actions/escalate-account.js';
import { defineGraph } from '../validation/target.js';
import { access } from './access.js';
import {
  AccountReview,
  Customer,
  Invoice,
  Task,
  objects,
  relationships,
} from './model.js';

// Bind the shared registry for related-field inference, not permission grants.
const { policy } = access.forObjects(objects);

// Object policies live here; action policies live on the action definitions.
// Either kind without a policy is denied to everyone.
export const graph = defineGraph({
  id: 'business.graph',
  objects,
  relationships,
  actions: {
    addAccountReview: AddAccountReview,
    escalateAccount: EscalateAccount,
    reviewInvoice: ReviewInvoice,
  },
  access,
  policies: [
    policy(Customer, {
      read: {
        gate: access.role('employee'),
        where: { portfolio: { eq: access.claims.portfolio } },
        evidenceMaxAgeMs: 30_000,
      },
      groups: { financial: access.role('finance') },
    }),
    policy(Invoice, {
      read: {
        gate: access.role('employee'),
        where: {
          customer: { portfolio: { eq: access.claims.portfolio } },
        },
        evidenceMaxAgeMs: 30_000,
      },
      groups: { financial: access.role('finance') },
    }),
    policy(AccountReview, {
      read: {
        gate: access.role('employee'),
        where: {
          customer: { portfolio: { eq: access.claims.portfolio } },
        },
        evidenceMaxAgeMs: 30_000,
      },
      create: {
        gate: access.role('account-manager'),
        where: {
          customer: { portfolio: { eq: access.claims.portfolio } },
          author: { eq: access.actor.id },
        },
        evidenceMaxAgeMs: 30_000,
      },
    }),
    // Permission follows Task's customer; integrity separately requires all
    // three references to identify that same customer.
    policy(Task, {
      read: {
        gate: access.role('employee'),
        where: {
          customer: { portfolio: { eq: access.claims.portfolio } },
        },
        evidenceMaxAgeMs: 30_000,
      },
      create: {
        gate: access.role('account-manager'),
        where: { customer: { portfolio: { eq: access.claims.portfolio } } },
        evidenceMaxAgeMs: 30_000,
      },
      integrity: ({ fields, same }) => [
        same(fields.customer, fields.invoice.customer),
        same(fields.customer, fields.review.customer),
      ],
    }),
  ],
});
