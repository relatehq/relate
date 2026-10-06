import { ReviewInvoice } from './actions/review-invoice.js';
import { AddAccountReview } from './actions/add-account-review.js';
import { EscalateAccount } from './actions/escalate-account.js';
import { defineGraph } from '../validation/target.js';
import { access } from './access.js';
import {
  AccountReview,
  Customer,
  CustomerInvoices,
  CustomerReviews,
  Invoice,
  ReviewTasks,
  Task,
  objects,
} from './model.js';

// Bind the shared registry for related-field inference, not permission grants.
const { policy } = access.forObjects(objects);

// Object policies live here; action policies live on the action definitions.
// Either kind without a policy is denied to everyone.
export const graph = defineGraph({
  id: 'business.graph',
  objects,
  relationships: { CustomerInvoices, CustomerReviews, ReviewTasks },
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
        where: { organization: { eq: access.claims.organization } },
        evidenceMaxAgeMs: 30_000,
      },
      groups: { financial: access.role('finance') },
    }),
    policy(Invoice, {
      read: {
        gate: access.role('employee'),
        where: {
          customer: { organization: { eq: access.claims.organization } },
        },
        evidenceMaxAgeMs: 30_000,
      },
      groups: { financial: access.role('finance') },
    }),
    policy(AccountReview, {
      read: {
        gate: access.role('employee'),
        where: {
          customer: { organization: { eq: access.claims.organization } },
        },
        evidenceMaxAgeMs: 30_000,
      },
    }),
    // Use Task's direct customer. Agreement with its review/invoice references
    // is a separate write/integrity requirement, not implied by readability.
    policy(Task, {
      read: {
        gate: access.role('employee'),
        where: {
          customer: { organization: { eq: access.claims.organization } },
        },
        evidenceMaxAgeMs: 30_000,
      },
    }),
  ],
});
